// Preview endpoint for the generated app's FILES and INTEGRATIONS surfaces.
//
// The builder preview runs the same generated code the deployed app runs, so its `files.*`
// and `integrations.*` bridge calls must reach the SAME certified server primitives the
// public runtime serves. The caller (the builder) is authorized against the project through
// the EXISTING authz path; the project's WORKING files and integrations are loaded server-side
// (never from the browser); the generated-app end-user session is resolved from the preview's
// own #29 session token, so RLS ownership behaves identically in preview and production.
//
// Files operations dispatch through the EXISTING createServerFiles accessor — this closes the
// preview forwarding gap where `files.*` bridge calls previously fell through to the db
// dispatcher and failed. Integrations operations dispatch through shared/appIntegrations.ts,
// the ONE module both surfaces share.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { loadProjectIntegrations } from "../../shared/integrations.ts";
import { resolveSessionRecord, publicUser, publicSession } from "../../shared/appAuth.ts";
import { createServerFiles } from "../../shared/appFiles.ts";
import { handleAppNotifications } from "../../shared/appNotifications.ts";
import { handleAppIntegrations, APP_INTEGRATION_OPS } from "../../shared/appIntegrations.ts";
import { handleAppPublicSettings, APP_PUBLIC_SETTINGS_OPS } from "../../shared/appPublicSettings.ts";

// The SAME operation vocabulary the deployed runtime's "files" action serves — no preview-only
// operation exists.
const FILES_OPS = ["upload", "upload_public", "get", "list", "access", "delete"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    // The builder's own platform session authorizes the preview — the same path every other
    // preview surface uses. It grants nothing on the generated app's data: that is the
    // #29 session token's role below.
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const { project } = await loadAuthorizedProject(base44, user, body.project_id);
    const svc = base44.asServiceRole || base44;
    const scope = String(body.scope || "integrations");
    const op = String(body.op || "");
    const args = body.args || {};
    const rls = !!project.rls_enabled;
    // The previewed app's END-USER session, resolved server-side exactly like the deployed
    // runtime resolves it. Only an RLS project requires one; an open app keeps its existing
    // anonymous behavior.
    const token = typeof body.session_token === "string" ? body.session_token : null;
    const resolved = rls && token ? await resolveSessionRecord(svc, project.id, token).catch(() => null) : null;
    const appUser = resolved ? publicUser(resolved.user) : null;
    const appSession = resolved ? publicSession(resolved.session) : null;

    if (scope === "notifications") {
      // The inbox is always session-bound (even on an open app), owner-scoped server-side.
      const own = token ? await resolveSessionRecord(svc, project.id, token).catch(() => null) : null;
      try {
        const result = await handleAppNotifications(svc, { projectId: project.id, user: own ? publicUser(own.user) : null, op, args });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    if (scope === "files") {
      if (!FILES_OPS.includes(op)) return Response.json({ error: `Unsupported file operation ${op}` }, { status: 400 });
      const files = createServerFiles(svc, project.id, { rls, user: appUser });
      try {
        const result = op === "upload" ? await files.upload(args)
          : op === "upload_public" ? await files.uploadPublic(args)
          : op === "get" ? await files.get(args.id)
          : op === "list" ? await files.list({ limit: args.limit })
          : op === "access" ? await files.access(args.id)
          : await files.delete(args.id);
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    if (scope === "integrations") {
      if (!APP_INTEGRATION_OPS.includes(op)) return Response.json({ error: `Unsupported integration operation ${op}` }, { status: 400 });
      // The project's OWN integration definitions, from its working files — the same source a
      // previewed backend function's ctx.integrations receives.
      const integrations = await loadProjectIntegrations(svc, project.id);
      try {
        // The preview has no email delivery, so the messaging transport stays "test" — the
        // primitive neither delivers nor charges, exactly like every other previewed
        // messaging path. The deployed runtime serves the "platform" transport.
        const result = await handleAppIntegrations(svc, {
          project, integrations, user: appUser, session: appSession,
          op, args, transport: "test",
        });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    if (scope === "app") {
      // AppModule parity (SDK 0.8.52 `base44.app.getPublicSettings()`): the SAME shared
      // handler the deployed runtime's "app" action serves — same gate, same mapping, same
      // documented 403 envelope — over the project resolved by the builder's authorization.
      if (!APP_PUBLIC_SETTINGS_OPS.includes(op)) return Response.json({ error: `Unsupported app operation ${op}` }, { status: 400 });
      try {
        const result = await handleAppPublicSettings(svc, project, { sessionToken: token });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null, ...(e.extra_data ? { extra_data: e.extra_data } : {}) }, { status: e.status || 400 });
      }
    }

    return Response.json({ error: `Unsupported scope ${scope}` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}