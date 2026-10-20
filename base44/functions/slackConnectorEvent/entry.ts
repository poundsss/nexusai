// Public Slack connector-EVENT webhook receiver.
//
// URL: <this function's URL>?project_id=<id>
//
// A SEPARATE receiver from `githubConnectorEvent` (the GitHub connector-event path, unchanged).
// This endpoint turns a verified Slack Events API delivery into a connector workflow dispatch
// through the existing `emitConnector` emitter.
//
// This endpoint has NO user session — authenticity comes entirely from the Slack HMAC
// signature. All request handling — rate limiting, signature verification, freshness, replay
// protection, url_verification handshake, connection resolution, normalization and dispatch —
// lives in shared/slackConnectorEvent.ts, so the endpoint and its certification harness exercise
// exactly the same code.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleSlackConnectorEvent } from "../../shared/slackConnectorEvent.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("project_id");
  const rawBody = await req.text();
  const headers = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  const result = await handleSlackConnectorEvent(svc, { projectId, rawBody, headers, now: Date.now() });
  return Response.json(result.body, { status: result.status });
}