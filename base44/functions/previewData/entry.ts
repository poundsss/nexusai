// Preview database endpoint. All authorization, schema resolution and CRUD happen in
// shared/previewData.ts — the browser only names an operation and its arguments.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePreviewData } from "../../shared/previewData.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  const body = await req.json().catch(() => ({}));
  try {
    const result = await handlePreviewData(base44, user, body);
    return Response.json({ result });
  } catch (error) {
    // Operation-level failures (validation, record not found, relation violations) are returned
    // as data so the preview surfaces the same messages it always did.
    return Response.json({ error: error.message, code: error.code || null });
  }
}