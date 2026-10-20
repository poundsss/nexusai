// Cancel an AI run. Authorization, the durable cancel flag, the terminal transition for a queued
// run and credit release all live in shared/runCancel.ts.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestRunCancel } from "../../shared/runCancel.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Sign in to cancel a run", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    return Response.json(await requestRunCancel(base44, user, { run_id: body.run_id }));
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}