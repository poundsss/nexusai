// Payment-provider abstraction.
//
// The provider layer does exactly three things: identify a customer, start a payment, and prove
// that an inbound event really came from the provider. It then translates the provider's own
// vocabulary into ONE canonical billing intent. It never computes a balance, never grants
// credits and never writes to the ledger — `billing.processBillingEvent` does that, so swapping
// providers cannot change what an account is worth.
//
// Provider secrets are read from the app's secret store at call time and are never returned,
// logged, echoed into an event payload or exposed to the client.
import { secrets } from "base44:runtime";

export class ProviderError extends Error {
  constructor(message, code = "PROVIDER_ERROR", status = 400, detail = {}) {
    super(message);
    this.code = code; this.status = status; this.detail = detail;
  }
}

const secret = (name) => { try { return secrets.get(name) || null; } catch { return null; } };

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Constant-time comparison: a signature check must not leak the correct value through timing.
export function safeEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secretValue, payload) {
  const key = await crypto.subtle.importKey("raw", enc.encode(String(secretValue)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(String(payload))));
}

export const periodKeyFor = (interval, at = new Date()) => {
  const d = at instanceof Date ? at : new Date(at);
  if (interval === "yearly") return String(d.getUTCFullYear());
  if (interval === "one_time") return `once-${d.toISOString().slice(0, 10)}`;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// --- manual provider ---------------------------------------------------------
// The always-available provider: invoicing handled out of band (wire transfer, enterprise
// contract, promotional grant, internal testing). Authenticity comes from a shared secret.
const manual = {
  name: "manual",
  configured: () => true,
  createCustomer: async ({ workspace_id, email, name }) => ({
    provider_customer_id: `manual_${workspace_id}`, email: email || null, name: name || null,
  }),
  // No hosted checkout exists; the caller settles the purchase through the authenticated
  // billing endpoint, which still produces a validated billing event.
  createCheckout: async ({ plan }) => ({ url: null, mode: "manual_settlement", plan_code: plan?.code || null, requires_manual_settlement: true }),
  createPortalSession: async () => { throw new ProviderError("The manual provider has no hosted billing portal", "PORTAL_UNAVAILABLE", 501); },
  verifyWebhook: async ({ rawBody, headers, secretValue }) => {
    const expected = secretValue || secret("WEBHOOK_SECRET");
    if (!expected) throw new ProviderError("Webhook secret is not configured", "WEBHOOK_SECRET_MISSING", 500);
    const provided = headers.get?.("x-webhook-secret") || "";
    let body = {};
    try { body = JSON.parse(rawBody || "{}"); } catch { throw new ProviderError("Malformed webhook body", "MALFORMED_PAYLOAD", 400); }
    if (!safeEqual(provided || body.secret || "", expected)) throw new ProviderError("Invalid webhook signature", "INVALID_SIGNATURE", 401);
    return { verified: true, provider: "manual", provider_event_id: body.provider_event_id || null, raw: { ...body, secret: undefined } };
  },
  mapEvent: (raw) => ({
    event_type: raw.event_type,
    provider_event_id: raw.provider_event_id || null,
    amount_cents: Number(raw.amount_cents) || 0,
    currency: raw.currency || "USD",
    credits: Number(raw.credits) || 0,
    plan_code: raw.plan_code || null,
    period_key: raw.period_key || null,
    period_start: raw.period_start || null,
    period_end: raw.period_end || null,
    provider_customer_id: raw.provider_customer_id || null,
    provider_subscription_id: raw.provider_subscription_id || null,
    provider_invoice_id: raw.provider_invoice_id || null,
    workspace_id: raw.workspace_id || null,
    user_id: raw.user_id || null,
    invoice: raw.invoice || null,
    payment_status: raw.payment_status || null,
    failure_reason: raw.failure_reason || null,
  }),
};

// --- stripe provider ---------------------------------------------------------
// Live Stripe integration over the REST API (no SDK needed). EXTERNAL DEPENDENCY: it activates
// only once STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are configured for the app; until then
// every call fails closed with PROVIDER_NOT_CONFIGURED instead of silently pretending to charge.
const STRIPE_API = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_S = 300;

const form = (obj, prefix = "", out = new URLSearchParams()) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
};

async function stripeApi(path, { method = "POST", body } = {}) {
  const apiKey = secret("STRIPE_SECRET_KEY");
  if (!apiKey) throw new ProviderError("Stripe is not configured for this app", "PROVIDER_NOT_CONFIGURED", 501);
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? form(body).toString() : undefined,
  });
  const json = await res.json().catch(() => ({}));
  // Only the provider's own message is surfaced — never the key that authenticated the call.
  if (!res.ok) throw new ProviderError(json?.error?.message || `Stripe request failed (${res.status})`, json?.error?.code || "PROVIDER_REQUEST_FAILED", res.status === 401 ? 500 : 400);
  return json;
}

// Pure translation of a Stripe event into the platform's canonical intent. Exported for tests:
// mapping is where a provider integration usually goes wrong, so it is verifiable in isolation.
export function mapStripeEvent(event) {
  const o = event?.data?.object || {};
  const meta = { ...(o.metadata || {}), ...(o.subscription_details?.metadata || {}) };
  const base = {
    provider_event_id: event?.id || null,
    currency: (o.currency || "usd").toUpperCase(),
    plan_code: meta.plan_code || null,
    workspace_id: meta.workspace_id || null,
    user_id: meta.user_id || null,
    provider_customer_id: typeof o.customer === "string" ? o.customer : o.customer?.id || null,
    provider_subscription_id: typeof o.subscription === "string" ? o.subscription : o.subscription?.id || o.id || null,
    // P-8.10: the price id a subscription change carries — the reverse-lookup key for the plan.
    provider_price_id: o.items?.data?.[0]?.price?.id || null,
    provider_invoice_id: typeof o.invoice === "string" ? o.invoice : o.invoice?.id || null,
    // Credits are taken from plan metadata only — a payload can never state an arbitrary
    // credit amount for a known plan; the plan record decides.
    credits: Number(meta.credits) || 0,
    amount_cents: Number(o.amount_total ?? o.amount_paid ?? o.amount ?? o.amount_captured ?? 0) || 0,
    // The service period's start anchors the P-8.9 period-scope dedupe: invoices carry
    // period_start/period_end; subscription events carry current_period_* (top-level or on the item).
    period_start: [o.period_start, o.current_period_start, o.items?.data?.[0]?.current_period_start].find((v) => v != null) != null
      ? new Date([o.period_start, o.current_period_start, o.items?.data?.[0]?.current_period_start].find((v) => v != null) * 1000).toISOString() : null,
    period_end: [o.period_end, o.current_period_end, o.items?.data?.[0]?.current_period_end].find((v) => v != null) != null
      ? new Date([o.period_end, o.current_period_end, o.items?.data?.[0]?.current_period_end].find((v) => v != null) * 1000).toISOString() : null,
    period_key: null, invoice: null, payment_status: null, failure_reason: null,
  };
  switch (event?.type) {
    case "checkout.session.completed":
      return { ...base, event_type: o.mode === "subscription" ? "subscription_started" : "credit_purchase", provider_invoice_id: base.provider_invoice_id, payment_status: "valid" };
    case "customer.subscription.created":
      return { ...base, event_type: o.status === "trialing" ? "trial_started" : "subscription_started", period_end: o.current_period_end ? new Date(o.current_period_end * 1000).toISOString() : null };
    case "customer.subscription.updated":
      return { ...base, event_type: o.cancel_at_period_end ? "subscription_updated" : "subscription_updated", cancel_at_period_end: !!o.cancel_at_period_end, provider_status: o.status || null };
    case "customer.subscription.deleted":
      return { ...base, event_type: "subscription_cancelled" };
    case "invoice.created":
      return { ...base, event_type: "invoice_created", provider_invoice_id: o.id || null, invoice: { provider_invoice_id: o.id, number: o.number || null, amount_cents: Number(o.amount_due) || 0, status: "open", hosted_invoice_url: o.hosted_invoice_url || null } };
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return { ...base, event_type: "subscription_renewed", provider_invoice_id: o.id || null, payment_status: "valid", amount_cents: Number(o.amount_paid) || 0, invoice: { provider_invoice_id: o.id, number: o.number || null, amount_cents: Number(o.amount_paid) || 0, status: "paid", hosted_invoice_url: o.hosted_invoice_url || null } };
    case "invoice.payment_failed":
      return { ...base, event_type: "payment_failed", provider_invoice_id: o.id || null, payment_status: "failing", failure_reason: o.last_finalization_error?.message || "Payment failed", invoice: { provider_invoice_id: o.id, number: o.number || null, amount_cents: Number(o.amount_due) || 0, status: "payment_failed", hosted_invoice_url: o.hosted_invoice_url || null } };
    case "charge.refunded":
      return { ...base, event_type: "refund", amount_cents: Number(o.amount_refunded) || 0, credits: Number(meta.credits) || 0, provider_invoice_id: base.provider_invoice_id };
    case "charge.dispute.created":
      return { ...base, event_type: "payment_disputed", amount_cents: Number(o.amount) || 0, payment_status: "disputed", failure_reason: o.reason || "Payment disputed" };
    default:
      // Unknown provider events are ignored rather than guessed at.
      return { ...base, event_type: null, ignored_type: event?.type || "unknown" };
  }
}

const stripe = {
  name: "stripe",
  configured: () => !!secret("STRIPE_SECRET_KEY"),
  createCustomer: async ({ workspace_id, email, name }) => {
    const customer = await stripeApi("/customers", { body: { email: email || undefined, name: name || undefined, metadata: { workspace_id } } });
    return { provider_customer_id: customer.id, email: customer.email || null, name: customer.name || null };
  },
  createCheckout: async ({ plan, workspace_id, user_id, customer, success_url, cancel_url, quantity = 1 }) => {
    if (!plan?.provider_price_id) throw new ProviderError(`Plan "${plan?.code}" has no Stripe price configured`, "PLAN_NOT_MIRRORED", 400);
    const session = await stripeApi("/checkout/sessions", {
      body: {
        mode: plan.interval === "one_time" ? "payment" : "subscription",
        customer: customer?.provider_customer_id || undefined,
        success_url, cancel_url,
        "line_items[0][price]": plan.provider_price_id,
        "line_items[0][quantity]": quantity,
        // The metadata is what lets a verified webhook be attributed to a workspace and plan.
        metadata: { workspace_id, user_id: user_id || "", plan_code: plan.code, credits: plan.included_credits || 0 },
        ...(plan.interval === "one_time" ? {} : { subscription_data: { metadata: { workspace_id, plan_code: plan.code, credits: plan.included_credits || 0 }, ...(plan.trial_days ? { trial_period_days: plan.trial_days } : {}) } }),
      },
    });
    return { url: session.url, session_id: session.id, mode: session.mode };
  },
  createPortalSession: async ({ customer, return_url }) => {
    if (!customer?.provider_customer_id) throw new ProviderError("No Stripe customer for this workspace", "NO_CUSTOMER", 400);
    const session = await stripeApi("/billing_portal/sessions", { body: { customer: customer.provider_customer_id, return_url } });
    return { url: session.url };
  },
  // Signature verification: HMAC-SHA256 over "<timestamp>.<rawBody>", constant-time compared,
  // with a timestamp tolerance so a captured request cannot be replayed later.
  verifyWebhook: async ({ rawBody, headers, secretValue, nowMs = Date.now() }) => {
    const signingSecret = secretValue || secret("STRIPE_WEBHOOK_SECRET");
    if (!signingSecret) throw new ProviderError("Stripe webhook secret is not configured", "WEBHOOK_SECRET_MISSING", 500);
    const header = headers.get?.("stripe-signature") || "";
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
    if (!parts.t || !parts.v1) throw new ProviderError("Missing Stripe signature", "INVALID_SIGNATURE", 401);
    const age = Math.abs(Math.floor(nowMs / 1000) - Number(parts.t));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_S) throw new ProviderError("Stripe signature timestamp outside tolerance", "SIGNATURE_EXPIRED", 401);
    const expected = await hmacSha256Hex(signingSecret, `${parts.t}.${rawBody}`);
    if (!safeEqual(parts.v1, expected)) throw new ProviderError("Invalid Stripe signature", "INVALID_SIGNATURE", 401);
    let event = {};
    try { event = JSON.parse(rawBody || "{}"); } catch { throw new ProviderError("Malformed webhook body", "MALFORMED_PAYLOAD", 400); }
    return { verified: true, provider: "stripe", provider_event_id: event.id || null, raw: event };
  },
  mapEvent: mapStripeEvent,
};

const PROVIDERS = { manual, stripe };

export const providerNames = () => Object.keys(PROVIDERS);

export function getProvider(name) {
  const provider = PROVIDERS[String(name || "manual")];
  if (!provider) throw new ProviderError(`Unknown payment provider "${name}"`, "UNKNOWN_PROVIDER", 400);
  return provider;
}

// The provider a live purchase should use: the configured external one when available,
// otherwise manual settlement. Never guessed per-request by the client.
export const defaultProvider = () => (stripe.configured() ? "stripe" : "manual");

export const providerStatus = () => providerNames().map((name) => ({ name, configured: PROVIDERS[name].configured(), hosted_checkout: name !== "manual" }));