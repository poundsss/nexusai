// Worker-authenticated signing-material delivery for the external native builder.
//
// This is an ADDITIVE helper for the external Android executor: the certified
// mobileNativeBuilder boundary (mobileNativeBuilder.ts + its entry's four actions) and every
// entity schema are UNCHANGED. The projection (projectNativeBuildInput) deliberately withholds
// the WorkspaceSecret VALUE from the claim response — the builder obtains the keystore it needs
// to SIGN through this separate, explicitly WORKER_SECRET-authenticated trusted path instead.
//
// The caller names a build_id it has already claimed; the platform resolves the workspace and
// platform SERVER-SIDE from that build, so a worker can never request an arbitrary workspace's
// credential by guessing — it may only receive the credential for a build that actually exists
// and is in a non-terminal state. The value is delivered only to a caller that proved it holds
// WORKER_SECRET (constant-time checked, same boundary as claim/heartbeat/submit), over HTTPS.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";
import { readSigningCredential, signingSecretName } from "../../shared/mobileSigning.ts";

const MOBILE_TERMINAL = ["READY", "FAILED", "CANCELLED"];

export default async function (req) {
  // Same worker boundary as the native builder: authenticated before anything is touched.
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "material");
    if (action !== "material") {
      return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
    }
    if (!body.build_id) {
      return Response.json({ error: "build_id is required" }, { status: 400 });
    }
    const svc = base44.asServiceRole || base44;
    // Resolve the build SERVER-SIDE: the worker cannot name a workspace — only a build it holds.
    const build = await svc.entities.MobileBuild.get(body.build_id).catch(() => null);
    if (!build) {
      return Response.json({ error: "Build not found", code: "BUILD_NOT_FOUND" }, { status: 404 });
    }
    if (MOBILE_TERMINAL.includes(build.status)) {
      return Response.json({ error: `Build is already ${build.status}`, code: "BUILD_ALREADY_TERMINAL" }, { status: 409 });
    }
    // The existing service-role read. Returns the raw stored credential text (the keystore
    // bundle as stored by putSigningCredential), or null when unset.
    const credential = await readSigningCredential(base44, build.workspace_id, build.platform);
    if (!credential) {
      return Response.json({
        error: `No ${build.platform} signing credential is configured for this workspace`,
        code: "MISSING_SIGNING_CREDENTIALS",
        platform: build.platform,
        secret_name: signingSecretName(build.platform),
      }, { status: 404 });
    }
    return Response.json({
      platform: build.platform,
      secret_name: signingSecretName(build.platform),
      // The credential VALUE — the keystore bundle — delivered only over this trusted path.
      credential,
    });
  } catch (e) {
    return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
  }
}