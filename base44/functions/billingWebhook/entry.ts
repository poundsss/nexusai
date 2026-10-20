// Payment-provider webhook receiver — provider-agnostic.
//
// Anyone can reach this endpoint, so NOTHING is trusted until the provider adapter has verified
// the request cryptographically (Stripe: HMAC over the raw body with a timestamp tolerance;
// manual: shared secret). Even then the payload cannot set a balance: it is translated into a
// canonical intent, attributed to a workspace through the stored customer mapping, and handed to
// the billing processor, which is the only thing that moves credits — idempotently.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { getProvider, ProviderError } from "../../shared/paymentProviders.ts";
import { processBillingEvent, resolveWorkspaceForEvent, planByProviderPrice } from "../../shared/billing.ts";
import { applyScheduledChanges } from "../../shared/subscriptions.ts";
import { deriveBalance } from "../../shared/ledger.ts";

// Canonical types this endpoint accepts. Anything else is ignored rather than guessed at.
const HANDLED = [
  "credit_purchase", "subscription_started", "subscription_renewed", "subscription_updated",
  "subscription_resumed", "subscription_cancelled", "trial_started", "payment_failed",
  "payment_disputed", "invoice_created", "refund", "promotional_grant", "adjustment",
];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    // The raw body is required: a re-serialized payload would not match the provider's signature.
    const rawBody = await req.text();

    const providerName = req.headers.get("stripe-signature") ? "stripe" : "manual";
    const provider = getProvider(providerName);

    let verified;
    try {
      verified = await provider.verifyWebhook({ rawBody, headers: req.headers });
    } catch (e) {
      // Verification failures are answered without detail and never processed.
      return Response.json({ error: e.message, code: e.code || "INVALID_SIGNATURE" }, { status: e.status || 401 });
    }

    const intent = provider.mapEvent(verified.raw);
    if (!intent.event_type || !HANDLED.includes(intent.event_type)) {
      return Response.json({ received: true, ignored: true, reason: `Unhandled provider event "${intent.ignored_type || intent.event_type || "unknown"}"` });
    }

    // P-8.10: a verified event carrying a provider price but no plan metadata (e.g. a subscription
    // changed through the provider's portal) resolves its plan from the plan mirror; an unmapped
    // price stays unmapped — the event is processed without a plan change (fail-closed).
    if (!intent.plan_code && intent.provider_price_id) {
      const priced = await planByProviderPrice(svc, providerName, intent.provider_price_id);
      if (priced) intent.plan_code = priced.code;
    }

    // Attribution: the customer mapping decides which workspace an event may credit, so a forged
    // workspace id in provider metadata cannot reach another account.
    let workspace_id;
    try {
      workspace_id = await resolveWorkspaceForEvent(svc, { provider: providerName, provider_customer_id: intent.provider_customer_id, workspace_id: intent.workspace_id });
    } catch (e) {
      return Response.json({ error: e.message, code: e.code }, { status: e.status || 403 });
    }
    if (!workspace_id) return Response.json({ error: "Event could not be attributed to a workspace", code: "UNATTRIBUTED_EVENT" }, { status: 400 });
    const workspace = await svc.entities.Workspace.get(workspace_id).catch(() => null);
    if (!workspace) return Response.json({ error: "Unknown workspace", code: "UNKNOWN_WORKSPACE" }, { status: 404 });

    const res = await processBillingEvent(svc, {
      ...intent,
      workspace_id,
      provider: providerName,
      provider_event_id: verified.provider_event_id || intent.provider_event_id,
      // Stored for audit with the secret stripped; provider payloads may carry customer data,
      // so only a short preview is retained.
      payload_preview: rawBody.slice(0, 500),
      idempotency_key: intent.idempotency_key || (verified.provider_event_id ? `${providerName}:${verified.provider_event_id}` : null),
    });

    // A verified event can advance the subscription period; safe to run on every delivery.
    await applyScheduledChanges(svc, { workspace_id }).catch(() => {});

    return Response.json({
      received: true, duplicate: res.duplicate, status: res.event.status,
      billing_event_id: res.event.id, credits_applied: res.credits_applied,
      balance: (await deriveBalance(svc, workspace_id)).balance,
    });
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : error.status || 500;
    return Response.json({ error: error.message, code: error.code || null }, { status });
  }
}