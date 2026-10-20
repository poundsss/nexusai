// Builder Preview runtime:error intake. See shared/previewErrorReport.ts for the contract.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { reportPreviewError } from "../../shared/previewErrorReport.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    return Response.json(await reportPreviewError(base44, user, body));
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}