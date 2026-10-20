// Mobile runtime session control plane (P-10.3 phase 3): mint, refresh and revoke the
// workspace-scoped bearer tokens a native client uses to reach the mobile runtime.
//
// Minting requires an authenticated workspace member holding deploy.manage (resolved
// server-side). Refresh is credential-based — the rotating refresh token itself proves
// possession, so a native device refreshes without a platform login. The RAW tokens exist
// only in the responses of this endpoint; storage keeps SHA-256 hashes only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createMobileRuntimeSession, refreshMobileRuntimeSession, revokeMobileRuntimeSession } from "../../shared/mobileRuntime.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "create_token");

    if (action === "create_token") {
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const out = await createMobileRuntimeSession(base44, user, { project_id: body.project_id });
      return Response.json(out);
    }

    if (action === "refresh") {
      const out = await refreshMobileRuntimeSession(svc, body.refresh_token);
      return Response.json(out);
    }

    if (action === "revoke") {
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const out = await revokeMobileRuntimeSession(base44, user, { session_id: body.session_id, refresh_token: body.refresh_token });
      return Response.json(out);
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
  }
}