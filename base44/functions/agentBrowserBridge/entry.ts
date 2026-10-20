// P-9.13B — the browser-extension bridge endpoint. POST only; NO provider, NO channel secret,
// NO persistent browser control:
//   pair      — the SIGNED-IN app user pairs (project.read authorization through the existing
//               loadAuthorizedProject path); returns the SAME single-use activation token
//               contract the certified channels use.
//   activate  — the extension consumes the pairing token exactly once → a hashed, expiring
//               bridge session bound to (project, agent, app user) + the AppIdentity row.
//   browse    — session-authenticated, bounded, SSRF-guarded, READ-ONLY page fetch + extraction.
//   fill      — session-authenticated; an LLM fill PLAN (values only) the extension applies to
//               the live DOM itself. The bridge never returns executable code and never fills
//               password/file/checkbox/radio fields.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { activateBridgeSession, resolveBridgeSession, bridgeBrowse, buildFillPlan } from "../../shared/agentBrowserBridge.ts";
import { issueToken } from "../../shared/appAuth.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    const body = await req.json().catch(() => ({}));
    const svc = base44.asServiceRole;
    const action = String(body.action || "");

    if (action === "pair") {
      if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
      const { project } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
      const agent = String(body.agent_name || "").trim();
      if (!agent) return Response.json({ error: "agent_name is required", code: "INVALID_INPUT" }, { status: 400 });
      const { token } = await issueToken(svc, project, {
        user: { id: user.id }, kind: "channel_activation", ttl_ms: 10 * 60 * 1000,
        data: { channel: "browser_extension", agent },
      });
      return Response.json({
        channel: "browser_extension", agent, token, expires_in_ms: 10 * 60 * 1000,
        bridge_url: `${new URL(req.url).origin}/api/functions/agentBrowserBridge`,
      });
    }

    const projectId = String(body.project_id || "");
    if (!projectId) return Response.json({ error: "project_id is required", code: "INVALID_INPUT" }, { status: 400 });
    const [project] = await svc.entities.Project.filter({ id: projectId }, "created_date", 1).catch(() => []);
    if (!project) return Response.json({ error: "Project not found", code: "NOT_FOUND" }, { status: 404 });

    if (action === "activate") {
      const out = await activateBridgeSession(svc, project, { token: String(body.token || ""), agentName: String(body.agent_name || "") });
      return Response.json(out);
    }

    const session = await resolveBridgeSession(svc, project, { sessionToken: String(body.session_token || "") });
    if (!session) return Response.json({ error: "The bridge session is missing, expired or revoked", code: "BRIDGE_UNAUTHORIZED" }, { status: 401 });

    if (action === "browse") {
      return Response.json(await bridgeBrowse({ url: String(body.url || "") }));
    }
    if (action === "fill") {
      const plan = await buildFillPlan({
        llm: (args) => base44.asServiceRole.integrations.Core.InvokeLLM(args),
        intent: String(body.intent || ""), page_text: String(body.page_text || ""), fields: body.fields,
      });
      return Response.json(plan);
    }
    if (action === "session_info") {
      return Response.json({ channel: "browser_extension", agent: session.agent, app_user_id: session.app_user_id });
    }
    return Response.json({ error: 'Unsupported action — use "pair", "activate", "browse", "fill" or "session_info"', code: "INVALID_ACTION" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}