// NexusAI Analytics operator API (#30).
//
// Thin authenticated boundary: it parses the request and delegates to the single operator handler
// (shared/analyticsOperator.ts), which resolves ownership and permission server-side and reuses the
// existing analyticsQuery layer. No query logic lives here.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleOperatorRequest } from "../../shared/analyticsOperator.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    return Response.json(await handleOperatorRequest(base44, body));
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || "ERROR" }, { status: e.status || 500 });
  }
}