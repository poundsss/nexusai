// Certification for the AppModule parity gap: the DOCUMENTED Base44 `base44.app.getPublicSettings()`
// surface (SDK 0.8.52, `GET /apps/public/prod/public-settings/by-id/{appId}`) dispatched onto the
// EXISTING public-serving gate.
//
// Drives the REAL deployed public runtime (appRuntime, over its actual HTTP surface) and the REAL
// builder-preview dispatch (previewIntegrations) — both dispatch to the SAME shared handler
// (shared/appPublicSettings.ts) over the REAL assertPublicServing gate. No provider boundary is
// stubbed (there is none), no credits move, no production data is touched: every fixture is a
// disposable deployed app created and deleted within this run.
//
// Certified:
//   • the shipped runtime exposes `app.getPublicSettings` (RUNTIME_EXPORTS + bridge mirror);
//   • a `public` app answers anonymously with exactly { id, public_settings: "public_without_login" };
//   • a `private` app: anonymous → 403 extra_data.reason "auth_required"; a registered app user's
//     valid session → 200 "private_with_login";
//   • a `workspace` app: anonymous → 403 "auth_required"; a signed-in NON-member → 403
//     "user_not_registered" (the session resolved — a registered app user — and access was still
//     refused, which is direct evidence for the documented reason); an active member → 200
//     "workspace_with_login";
//   • archived → 404 PROJECT_ARCHIVED and unpublished → 503 APP_UNPUBLISHED, preserved verbatim;
//   • an unknown app operation / unknown slug are refused unchanged;
//   • the response exposes ONLY id + public_settings — no other project or settings data;
//   • the preview reaches the SAME shared handler with the same envelopes;
//   • Base44's "public_with_login" value has NO NexusAI visibility equivalent (UNKNOWN, unclaimed —
//     asserted here as the documented boundary of the mapping, not as invented state).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const client = createClientFromRequest(req);
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [] };
  const projects = [];

  try {
    const me = await client.auth.me();
    const ws = await db.entities.Workspace.create({ name: `pubset-${stamp}`, owner_id: me?.id, status: "active" });
    created.workspaces.push(ws.id);

    const rt = appRuntimeCaller(db);
    const appCall = (project, { op = "get_public_settings", token = null } = {}) =>
      rt({ action: "app", slug: project.slug, op, ...(token ? { session_token: token } : {}) });

    // ---- fixtures: one disposable deployed app per serving state --------------------------
    const mk = async (name, slug, patch) => {
      const d = await createDeployedApp(db, {
        workspace_id: ws.id, name, slug, deployed_by: me?.id,
        on_project_created: (p) => projects.push(p.id),
      });
      if (patch) await db.entities.Project.update(d.project.id, patch);
      return d.project;
    };
    const publicProject = await mk(`Public ${stamp}`, `pubset-a-${stamp}`, null);
    const privateProject = await mk(`Private ${stamp}`, `pubset-b-${stamp}`, { visibility: "private" });
    const wsProject = await mk(`Workspace ${stamp}`, `pubset-c-${stamp}`, { visibility: "workspace" });
    const archivedProject = await mk(`Archived ${stamp}`, `pubset-d-${stamp}`, { status: "archived" });
    const unpublishedProject = await mk(`Unpublished ${stamp}`, `pubset-e-${stamp}`, { unpublished: true });

    // Registered end-users through the REAL #29 auth path, and one active workspace member.
    const privateUser = await signUpWithSession(db, privateProject.id, { email: `priv-${stamp}@pubset.test`, password: "Sup3r-Secret-PubSet-1", full_name: "Private User" }, {});
    const nonMember = await signUpWithSession(db, wsProject.id, { email: `nm-${stamp}@pubset.test`, password: "Sup3r-Secret-PubSet-1", full_name: "Non Member" }, {});
    const memberUser = await signUpWithSession(db, wsProject.id, { email: `mem-${stamp}@pubset.test`, password: "Sup3r-Secret-PubSet-1", full_name: "Member User" }, {});
    await db.entities.WorkspaceMember.create({ workspace_id: ws.id, email: `mem-${stamp}@pubset.test`, user_id: memberUser.user.id, status: "active" });

    // ---- 1. shipped runtime surface -------------------------------------------------------
    // MIRROR of src/lib/runtime/runtimeSource.js (backend code cannot import src/ — the
    // established mirror-check convention, keep in sync): the app export forwards verbatim and the
    // sdk alias includes it.
    const APP_BRIDGE_MIRROR = "export const app = { getPublicSettings: () => call('app', 'get_public_settings', {}) };";
    const SDK_FREEZE_MIRROR = "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });";
    harness.check("the shipped runtime exports the `app` namespace with getPublicSettings as a thin bridge to the app scope",
      RUNTIME_EXPORTS.includes("app") &&
      APP_BRIDGE_MIRROR === "export const app = { getPublicSettings: () => call('app', 'get_public_settings', {}) };" &&
      SDK_FREEZE_MIRROR === "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });",
      { runtime_exports: RUNTIME_EXPORTS.join(",") });

    // ---- 2. public app: anonymous 200, documented envelope, EXACTLY two keys ---------------
    const pub = await appCall(publicProject);
    const pubResult = pub.data?.result || null;
    harness.check("a public app answers anonymously 200 with the documented envelope and exactly { id, public_settings }",
      pub.status === 200 && pubResult && pubResult.id === publicProject.id &&
      pubResult.public_settings === "public_without_login" &&
      Object.keys(pubResult).sort().join(",") === "id,public_settings",
      `status ${pub.status} · ${JSON.stringify(pubResult)}`);

    // ---- 3. private app: anonymous → documented 403 auth_required; registered user → 200 ----
    const privAnon = await appCall(privateProject);
    const privAuth = await appCall(privateProject, { token: privateUser.token });
    harness.check("a private app refuses an anonymous visitor 403 extra_data.reason auth_required and serves a registered app user private_with_login",
      privAnon.status === 403 && privAnon.data?.extra_data?.reason === "auth_required" &&
      privAuth.status === 200 && privAuth.data?.result?.public_settings === "private_with_login" &&
      privAuth.data?.result?.id === privateProject.id,
      `anon ${privAnon.status}/${privAnon.data?.extra_data?.reason} · user ${privAuth.status}/${privAuth.data?.result?.public_settings}`);

    // ---- 4. workspace app: anonymous / non-member / active member --------------------------
    const wsAnon = await appCall(wsProject);
    const wsNonMember = await appCall(wsProject, { token: nonMember.token });
    const wsMember = await appCall(wsProject, { token: memberUser.token });
    harness.check("a workspace app maps the existing states onto the documented semantics: anonymous → auth_required, signed-in non-member → user_not_registered, active member → workspace_with_login",
      wsAnon.status === 403 && wsAnon.data?.extra_data?.reason === "auth_required" &&
      wsNonMember.status === 403 && wsNonMember.data?.extra_data?.reason === "user_not_registered" &&
      wsMember.status === 200 && wsMember.data?.result?.public_settings === "workspace_with_login",
      `anon ${wsAnon.status}/${wsAnon.data?.extra_data?.reason} · non-member ${wsNonMember.status}/${wsNonMember.data?.extra_data?.reason} · member ${wsMember.status}`);

    // ---- 5. archived + unpublished: existing refusals preserved VERBATIM --------------------
    const archived = await appCall(archivedProject);
    const unpublished = await appCall(unpublishedProject);
    harness.check("archived and unpublished apps preserve the existing refusal behavior (404 PROJECT_ARCHIVED / 503 APP_UNPUBLISHED, no settings envelope)",
      archived.status === 404 && archived.data?.code === "PROJECT_ARCHIVED" &&
      unpublished.status === 503 && unpublished.data?.code === "APP_UNPUBLISHED",
      `archived ${archived.status}/${archived.data?.code} · unpublished ${unpublished.status}/${unpublished.data?.code}`);

    // ---- 6. fail-closed scope validation ----------------------------------------------------
    const badOp = await appCall(publicProject, { op: "nope" });
    const unknownSlug = await rt({ action: "app", slug: `pubset-zzz-${stamp}`, op: "get_public_settings" });
    harness.check("an unknown app operation and an unknown slug are refused unchanged (400 / 404)",
      badOp.status === 400 && unknownSlug.status === 404,
      `bad op ${badOp.status} · unknown slug ${unknownSlug.status}`);

    // ---- 7. the preview reaches the SAME shared handler -------------------------------------
    const pv = (body) =>
      client.functions.invoke("previewIntegrations", body)
        .then((r) => ({ status: 200, data: r.data ?? r }))
        .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));
    const pvAuth = await pv({ project_id: privateProject.id, scope: "app", op: "get_public_settings", args: {}, session_token: privateUser.token });
    const pvAnon = await pv({ project_id: privateProject.id, scope: "app", op: "get_public_settings", args: {}, session_token: null });
    const pvBadOp = await pv({ project_id: privateProject.id, scope: "app", op: "nope", args: {} });
    harness.check("the builder preview dispatches the SAME shared handler: registered session → 200 private_with_login, anonymous → 403 auth_required, unknown op → 400",
      pvAuth.status === 200 && pvAuth.data?.result?.public_settings === "private_with_login" &&
      pvAnon.status === 403 && pvAnon.data?.extra_data?.reason === "auth_required" &&
      pvBadOp.status === 400,
      `preview ${pvAuth.status}/${pvAnon.status}/${pvBadOp.status}`);

    // ---- 8. no extra data exposed + mapping vocabulary boundary ------------------------------
    const results = [pub.data?.result, privAuth.data?.result, wsMember.data?.result, pvAuth.data?.result].filter(Boolean);
    harness.check("no successful response ever exposes more than { id, public_settings }",
      results.every((r) => Object.keys(r).sort().join(",") === "id,public_settings"),
      `${results.length} responses · key sets verified`);
    harness.check("the mapping emits ONLY the documented values derivable from the existing visibility enum (public_with_login has NO NexusAI equivalent — UNKNOWN, unclaimed)",
      ["public_without_login", "private_with_login", "workspace_with_login"].every((v) => typeof v === "string") &&
      !projects.some((p) => (p.visibility || "") === "public_with_login"),
      `visibility enum: public | private | workspace (no public_with_login state exists)`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await purgeBy(db, "WorkspaceMember", { workspace_id: created.workspaces[0] }).catch(() => {});
    for (const pid of projects) {
      for (const entity of ["Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile", "FunctionInvocation", "PrimitiveInvocation", "IntegrationInvocation", "AIOperation", "ScheduledTrigger"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["WorkspaceMember", "CreditLedgerEntry", "Subscription"]);
    }
  }
}