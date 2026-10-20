// Preview endpoint for a generated app's END-USER auth. All authorization, session resolution and
// identity projection happen in shared/previewAuth.ts — the browser only names an operation.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePreviewAuth } from "../../shared/previewAuth.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me().catch(() => null);
    const body = await req.json().catch(() => ({}));
    // The request's own origin is the app's serving origin for the preview: same-origin absolute
    // redirect_login destinations validate against it (relative paths need no origin).
    const origin = new URL(req.url).origin;
    const result = await handlePreviewAuth(base44, user, body, { origin });
    return Response.json({ result });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 400 });
  }
}