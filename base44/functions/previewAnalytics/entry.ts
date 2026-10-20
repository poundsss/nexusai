// Preview endpoint for a generated app's product analytics. Authorization, ownership resolution,
// validation and storage all live in the existing analytics layer — see shared/previewAnalytics.ts.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePreviewAnalytics } from "../../shared/previewAnalytics.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me().catch(() => null);
    const body = await req.json().catch(() => ({}));
    return Response.json({ result: await handlePreviewAnalytics(base44, user, body) });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 400 });
  }
}