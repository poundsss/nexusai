// Microsoft Graph subscription renewal sweeper — invoked on a schedule by the
// "Graph Subscription Renewal" workflow (existing scheduled-trigger infrastructure).
//
// Renews every active GraphSubscription whose expiration_date_time is within the renewal lead
// window. Each renewal PATCHes the existing subscription (never POSTs), so this sweeper cannot
// create duplicate subscriptions. Failures are recorded for the next sweep; a subscription that
// is gone on the provider side is marked deleted.
//
// This endpoint has NO user session — it runs as the service role on a documented schedule.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { renewExpiringSubscriptions } from "../../shared/msGraphSubscriptions.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const result = await renewExpiringSubscriptions(svc, {});
  return Response.json(result);
}