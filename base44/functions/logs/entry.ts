// Thin authenticated boundary for the Logs page. No query logic lives here — it delegates to
// shared/logsQuery.ts, which reuses the existing TraceEvent / FunctionInvocation / AuditLog
// backend and authorizes the caller against the project server-side.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleLogsRequest } from "../../shared/logsQuery.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    return Response.json(await handleLogsRequest(base44, body));
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || "ERROR" }, { status: e.status || 500 });
  }
}