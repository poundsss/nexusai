// Google Calendar / Drive watch renewal sweeper — invoked on a schedule by the
// "Google Watch Renewal" workflow (existing scheduled-trigger infrastructure).
//
// Re-watches every active GoogleWatchChannel (Calendar/Drive) whose expiration is within the
// renewal lead window. Each renewal re-issues a watch and UPDATES the existing row — never a new
// row — so this sweeper cannot create duplicate channels. Failures are recorded for the next
// sweep; a channel that is gone on the provider side is best-effort stopped. Drive's ~24h ceiling
// is why the workflow runs frequently. This sweeper does NOT dispatch workflow events.
//
// This endpoint has NO user session — it runs as the service role on a documented schedule.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { renewExpiringWatchChannels } from "../../shared/googleWatchSubscriptions.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const result = await renewExpiringWatchChannels(svc, {});
  return Response.json(result);
}