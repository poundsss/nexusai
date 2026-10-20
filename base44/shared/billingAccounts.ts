// Billing accounts: the customer record and the invoice history.
//
// Both are provider MIRRORS, not authorities. A customer row maps one workspace to one provider
// identity so a verified webhook can be attributed to an account; an invoice row is a receipt of
// something the provider already settled. Neither ever states a credit balance — the ledger does.
// Kept separate from `billing.ts` and `subscriptions.ts` so both can use it without a cycle.

export const customerFor = async (base44, workspace_id, provider = null) => {
  const rows = await base44.entities.BillingCustomer.filter({ workspace_id, ...(provider ? { provider } : {}) }, "-updated_date", 5);
  return rows[0] || null;
};

export const customerByProviderId = async (base44, provider, provider_customer_id) => {
  if (!provider_customer_id) return null;
  const rows = await base44.entities.BillingCustomer.filter({ provider, provider_customer_id }, "-updated_date", 2);
  return rows[0] || null;
};

/**
 * Idempotent customer creation: one row per workspace + provider. Calling it twice returns the
 * same customer instead of creating a second billing identity for the same account.
 */
export async function ensureCustomer(base44, { workspace_id, provider = "manual", email = null, name = null, provider_customer_id = null, user_id = null, createRemote = null }) {
  if (!workspace_id) throw new Error("billing: workspace_id is required");
  const existing = await customerFor(base44, workspace_id, provider);
  if (existing) {
    // A provider id learned later (first checkout) is attached to the existing row.
    if (provider_customer_id && existing.provider_customer_id !== provider_customer_id) {
      return base44.entities.BillingCustomer.update(existing.id, { provider_customer_id });
    }
    return existing;
  }
  let remoteId = provider_customer_id;
  if (!remoteId && typeof createRemote === "function") {
    const remote = await createRemote();
    remoteId = remote?.provider_customer_id || null;
  }
  return base44.entities.BillingCustomer.create({
    workspace_id, provider, provider_customer_id: remoteId, email, name,
    billing_state: "active", payment_status: "none", created_by: user_id,
  });
}

// Account standing transitions, derived from validated events only.
export async function applyPaymentState(base44, { workspace_id, provider = "manual", payment_status = null, failure_reason = null, disputed = false, paid = false }) {
  const customer = await customerFor(base44, workspace_id, provider) || await customerFor(base44, workspace_id);
  if (!customer) return null;
  const patch = {};
  if (payment_status) patch.payment_status = payment_status;
  if (paid) {
    patch.billing_state = "active"; patch.payment_status = "valid";
    patch.last_payment_at = new Date().toISOString(); patch.delinquent_since = null; patch.last_failure_reason = null;
  }
  if (payment_status === "failing") {
    patch.billing_state = "delinquent";
    patch.delinquent_since = customer.delinquent_since || new Date().toISOString();
    // Only a short, safe reason is retained — never a provider payload or credential.
    patch.last_failure_reason = String(failure_reason || "Payment failed").slice(0, 200);
  }
  if (disputed) { patch.billing_state = "delinquent"; patch.payment_status = "disputed"; patch.last_failure_reason = String(failure_reason || "Payment disputed").slice(0, 200); }
  if (!Object.keys(patch).length) return customer;
  return base44.entities.BillingCustomer.update(customer.id, patch);
}

/**
 * Invoice mirror. Dedup is (workspace_id, provider_invoice_id), so a replayed invoice webhook
 * updates the one receipt rather than duplicating billing history.
 */
export async function upsertInvoice(base44, { workspace_id, provider = "manual", invoice, plan_code = null, period_key = null, credits_granted = 0, billing_event_id = null, amount_cents = null, status = null }) {
  if (!workspace_id) return null;
  const providerInvoiceId = invoice?.provider_invoice_id || null;
  const existing = providerInvoiceId
    ? (await base44.entities.Invoice.filter({ workspace_id, provider_invoice_id: providerInvoiceId }, "-created_date", 2))[0] || null
    : null;
  const data = {
    workspace_id, provider, provider_invoice_id: providerInvoiceId,
    number: invoice?.number || existing?.number || null,
    plan_code: plan_code || existing?.plan_code || null,
    period_key: period_key || existing?.period_key || null,
    amount_cents: amount_cents ?? invoice?.amount_cents ?? existing?.amount_cents ?? 0,
    currency: invoice?.currency || existing?.currency || "USD",
    credits_granted: credits_granted || existing?.credits_granted || 0,
    status: status || invoice?.status || existing?.status || "open",
    hosted_invoice_url: invoice?.hosted_invoice_url || existing?.hosted_invoice_url || null,
    issued_at: existing?.issued_at || new Date().toISOString(),
    paid_at: (status || invoice?.status) === "paid" ? new Date().toISOString() : existing?.paid_at || null,
    billing_event_id: billing_event_id || existing?.billing_event_id || null,
  };
  return existing ? base44.entities.Invoice.update(existing.id, data) : base44.entities.Invoice.create(data);
}

export async function recordRefundOnInvoice(base44, { workspace_id, provider_invoice_id, amount_cents = 0 }) {
  if (!provider_invoice_id) return null;
  const invoice = (await base44.entities.Invoice.filter({ workspace_id, provider_invoice_id }, "-created_date", 2))[0];
  if (!invoice) return null;
  const refunded = (invoice.amount_refunded_cents || 0) + Math.abs(amount_cents || 0);
  return base44.entities.Invoice.update(invoice.id, {
    amount_refunded_cents: refunded,
    status: refunded >= (invoice.amount_cents || 0) && (invoice.amount_cents || 0) > 0 ? "refunded" : "partially_refunded",
  });
}

export const invoicesFor = (base44, workspace_id, limit = 50) => base44.entities.Invoice.filter({ workspace_id }, "-created_date", limit);