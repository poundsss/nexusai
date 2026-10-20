// Worker-authenticated binary artifact upload for the external native builder.
//
// ADDITIVE helper: the certified mobileNativeBuilder boundary (mobileNativeBuilder.ts + its
// entry's four actions) and every entity schema are UNCHANGED. The existing submitNativeBuildResult
// requires an `artifact_uri` that already lives in the app's PRIVATE storage — but the boundary's
// four actions (enqueue/claim/heartbeat/submit) offer no way for an external worker to put the
// AAB it just built into that storage. This function closes that gap by accepting the built
// binary over multipart and storing it through the EXISTING UploadPrivateFile integration, which
// is the same private-storage path packBinaryPackage uses for the `.mobpkg` fallback.
//
// The caller is WORKER_SECRET-authenticated (same boundary as the native builder) and names the
// build_id the upload belongs to. The build's platform is recorded so submitNativeBuildResult's
// platform-match check still gatekeeps the result. No file content is ever returned — only the
// resulting private file_uri, which the worker hands to `submit`.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  try {
    const form = await req.formData();
    const build_id = String(form.get("build_id") || "");
    const file = form.get("file");
    if (!build_id) {
      return Response.json({ error: "build_id is required" }, { status: 400 });
    }
    if (!file || typeof file === "string") {
      return Response.json({ error: "file (the built binary) is required" }, { status: 400 });
    }
    const svc = base44.asServiceRole || base44;
    // Resolve the build server-side so the upload is bound to a real, non-terminal build and the
    // recorded platform drives the submit platform-match gate.
    const build = await svc.entities.MobileBuild.get(build_id).catch(() => null);
    if (!build) {
      return Response.json({ error: "Build not found", code: "BUILD_NOT_FOUND" }, { status: 404 });
    }
    // Store through the EXISTING private-storage integration — the same store packBinaryPackage
    // writes `.mobpkg` bundles to. Content-addressed by the caller's filename convention.
    const filename = file.name || `native-${build.platform}-${build.id}.aab`;
    const stored = await svc.integrations.Core.UploadPrivateFile({ file });
    return Response.json({
      file_uri: stored.file_uri,
      platform: build.platform,
      build_id,
      filename,
      size: typeof file.size === "number" ? file.size : null,
    });
  } catch (e) {
    return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
  }
}