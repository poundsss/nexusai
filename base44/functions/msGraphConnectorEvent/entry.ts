// Public Microsoft Graph connector-EVENT webhook receiver (INGRESS).
//
// URL: <this function's URL>?project_id=<id>
//       (Graph subscription validation also adds &validationToken=<token>)
//
// A SEPARATE receiver from the GitHub/Slack connector-event receivers. This endpoint turns a
// verified Microsoft Graph change notification into a connector workflow dispatch through the
// existing `emitConnector` emitter, and answers Graph's validationToken handshake.
//
// This endpoint has NO user session — authenticity comes from the per-notification `clientState`
// (validated against the project's MS_GRAPH_CLIENT_STATE secret). All request handling —
// handshake, rate limit, clientState validation, subscription resolution, replay protection,
// lifecycle handling and dispatch — lives in shared/msGraphConnectorEvent.ts, so the endpoint
// and its certification harness exercise exactly the same code.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleMsGraphConnectorEvent } from "../../shared/msGraphConnectorEvent.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("project_id");
  const validationToken = url.searchParams.get("validationToken");
  const rawBody = await req.text();
  const headers = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  const result = await handleMsGraphConnectorEvent(svc, { projectId, rawBody, headers, validationToken, now: Date.now() });
  if (result.contentType === "text/plain") {
    return new Response(result.body, { status: result.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return Response.json(result.body, { status: result.status });
}