// Public Google Calendar / Drive connector-EVENT webhook receiver (INGRESS).
//
// URL: <this function's URL>?project_id=<id>
//
// A SEPARATE receiver from the GitHub / Slack / Microsoft-Graph connector-event receivers. This
// endpoint turns a verified Google web_hook push notification into a connector workflow dispatch
// through the existing `emitConnector` emitter.
//
// Google Calendar / Drive push notifications carry an EMPTY body with ALL metadata in X-Goog-*
// headers, so this endpoint reads the body as raw text (never requiring JSON) and passes the
// lowercased headers to the shared handler. This endpoint has NO user session — authenticity
// comes from the per-notification X-Goog-Channel-Token validated against the project's
// GOOGLE_CHANNEL_TOKEN secret. All request handling — rate limit, token validation, channel
// resolution, sync handling, replay protection and dispatch — lives in
// shared/googleChannelConnectorEvent.ts, so the endpoint and its certification harness exercise
// exactly the same code.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleGoogleChannelConnectorEvent } from "../../shared/googleChannelConnectorEvent.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("project_id");
  // The body is intentionally read but unused — Google sends an empty body. Read it so the
  // request stream is drained, but never require JSON.
  await req.text().catch(() => {});
  const headers = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  const result = await handleGoogleChannelConnectorEvent(svc, { projectId, headers, now: Date.now() });
  return Response.json(result.body, { status: result.status });
}