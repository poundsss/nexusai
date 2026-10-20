// P-10.3 phase 2 completion — the authorized HTTP entry point for the mobile signing execution.
//
// Completes the device signing/notarization execution path: a READY MobileBuild, signed with the
// workspace's stored signing credential, producing a verified detached signature over the
// immutable packaged bytes and stamping signed_at so the downstream store-publish VALIDATING gate
// (build.signed_at) passes. See shared/mobileSigningChain.ts for the full contract.
//
// Reuses the EXISTING deploy.manage capability (the same capability that requests a mobile build
// and uploads to a store), resolved server-side against the build's project. No new contract,
// entity, scheduler, or certified implementation is introduced.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { signMobileBuild } from "../../shared/mobileSigningChain.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!body.build_id) return Response.json({ error: "build_id is required" }, { status: 400 });
  try {
    const result = await signMobileBuild(base44, user, { build_id: body.build_id });
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: e.message || "Signing failed", code: e.code || "SIGNING_ERROR" },
      { status: e.status || 500 },
    );
  }
}