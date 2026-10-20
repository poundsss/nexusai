// Disposable two-phase E2E fixture for the DEPLOYED-HOST auth bridge (PublicApp.jsx).
//
// Purpose: prove that the five account-management auth ops (update_profile, change_password,
// request_password_reset, confirm_password_reset, invite_user) reach the certified appRuntime
// auth action through the REAL host page bridge — a real live deployment rendered by the real
// host page, whose generated app code calls the runtime's auth exports — not through direct
// appRuntime calls (the already-certified dispatch path).
//
//   op "setup"   → provisions a disposable workspace + deployed app + verified app user and
//                  returns the credentials; the browser then drives /app/<slug> and reads the
//                  results element the generated app renders.
//   op "cleanup" → removes every created row (mirrors the certification-suite cleanup).
//
// NO email is ever sent: the fixture workspace carries credits_balance 0, so the email hold
// refuses fail-closed BEFORE any platform send (deliveries resolve to delivered:false /
// invitation_sent:false; both ops still return their success envelopes).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createDeployedApp, MINIMAL_MAIN, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { cleanupAndVerify, cleanupDetail } from "../../shared/certCleanup.ts";

const FIXTURE_NAMES = ["Host Auth Bridge E2E", "Host Auth Redirect E2E"];
const SLUG_PREFIXES = ["hostauth-e2e-", "hostauth-rl-e2e-"];
const forbidden = () => Response.json({ error: "Forbidden" }, { status: 403 });
const safeError = (e) => String((e && e.message) || e).slice(0, 300);

// Read-only gate run before ANY side effect: the workspace must exist, be owned by the caller,
// carry an exact fixture name, and every project in it must carry a fixture slug. Missing and
// foreign resources get the same 403, so existence is never disclosed.
async function requireFixtureWorkspace(svc, caller, workspace_id) {
  if (!workspace_id) return { denied: forbidden() };
  const ws = await svc.entities.Workspace.get(String(workspace_id)).catch(() => null);
  if (!ws || ws.owner_id !== caller.id || !FIXTURE_NAMES.includes(ws.name)) return { denied: forbidden() };
  const projects = await svc.entities.Project.filter({ workspace_id: ws.id }, "created_date", 500).catch(() => null);
  if (!projects) return { denied: forbidden() };
  if (projects.some((p) => !SLUG_PREFIXES.some((pre) => String(p.slug || "").startsWith(pre)))) return { denied: forbidden() };
  return { ws, projects };
}

const PASSWORD = "Acct-0ps-Cert-0!";
const NEW_PASSWORD = "Acct-0ps-New-9!";

// The generated app: one component that runs the five-op sequence through the REAL host
// bridge on load and renders the recorded envelopes into #e2e-results.
const APP_SOURCE = (cred) => `import { html, auth } from 'runtime';
const EMAIL = ${JSON.stringify(cred.email)};
const PASSWORD = ${JSON.stringify(cred.password)};
const NEWPW = ${JSON.stringify(cred.new_password)};
const INVITEE = ${JSON.stringify(cred.invite_email)};
const ADMIN_INVITEE = ${JSON.stringify(cred.admin_invite_email)};
const seq = [];
const ok = (k, v) => seq.push({ k, v: v === undefined ? null : v });
const err = (k, e) => seq.push({ k, error: String((e && e.message) || e) });
async function run() {
  try {
    const u = await auth.login({ email: EMAIL, password: PASSWORD });
    ok('login', { ok: !!(u && u.id) });
    const upd = await auth.updateMe({ display_name: 'Renamed E2E' });
    ok('updateMe', { display_name: upd && upd.display_name });
    try { await auth.changePassword({ currentPassword: 'definitely-wrong', newPassword: NEWPW }); ok('change_pw_wrong', { ok: true }); }
    catch (e) { err('change_pw_wrong', e); }
    const chg = await auth.changePassword({ currentPassword: PASSWORD, newPassword: NEWPW });
    ok('change_pw', { ok: !!(chg && chg.ok), sessions_revoked: (chg && chg.sessions_revoked) || 0 });
    const me = await auth.me();
    ok('me_after', { display_name: me && me.display_name });
    const req = await auth.resetPasswordRequest(EMAIL);
    ok('reset_req', { ok: !!(req && req.ok) });
    try { await auth.resetPassword({ resetToken: 'not-a-real-token', newPassword: PASSWORD }); ok('reset_confirm', { ok: true }); }
    catch (e) { err('reset_confirm', e); }
    const inv = await auth.inviteUser(INVITEE, 'user');
    ok('invite_user', { ok: !!(inv && inv.ok), invitation_sent: !!(inv && inv.invitation_sent), invited_roles: (inv && inv.user && inv.user.roles) || [] });
    try { await auth.inviteUser(ADMIN_INVITEE, 'admin'); ok('invite_admin', { ok: true }); }
    catch (e) { err('invite_admin', e); }
  } catch (e) {
    err('fatal', e);
  }
  const el = document.createElement('pre');
  el.id = 'e2e-results';
  el.textContent = JSON.stringify(seq);
  document.body.appendChild(el);
  // Relay for the E2E harness: the sandboxed iframe's DOM is opaque to the host, so the
  // recorded envelopes also ride a postMessage to the parent (the same channel the runtime
  // bridge itself uses for bridge:call).
  try { parent.postMessage({ type: 'e2e:results', seq }, '*'); } catch (e) { /* host closed */ }
}
run();
export default function App() { return html\`<div class="page">E2E</div>\`; }
`;

// The deployed-host redirect E2E app: one component whose boot route selects the
// auth.redirectToLogin variant (default / explicit relative / same-origin absolute / two
// refusals) and records the resolved from_url or the refusal error into #e2e-results.
const REDIRECT_APP_SOURCE = (origin, slug) => `import { html, auth, useRoute } from 'runtime';
const BASE = ${JSON.stringify(`${origin}/app/${slug}`)};
const VARIANTS = {
  // The DEFAULT case mirrors real usage: the app calls redirectToLogin() after determining the
  // visitor is NOT signed in — so a re-boot with a live session skips, no loop.
  '/v-default': async () => {
    try { const me = await auth.me(); if (me && me.authenticated) return { skipped: true }; } catch (e) { /* not signed in */ }
    return auth.redirectToLogin();
  },
  '/v-relative': () => auth.redirectToLogin('/todos?utm=e2e'),
  '/v-sameorigin': () => auth.redirectToLogin(BASE + '/pricing'),
};
const done = {};
async function runKey(key) {
  if (done[key]) return;
  done[key] = 1;
  const records = [];
  const one = async (label, fn) => {
    try { const r = await fn(); records.push({ label, resolved: r && r.from_url }); }
    catch (e) { records.push({ label, error: String((e && e.message) || e) }); }
  };
  if (key === '/') {
    await one('external', () => auth.redirectToLogin('https://evil.example.com/phish'));
    await one('protocol_relative', () => auth.redirectToLogin('//evil.example.com/x'));
  } else {
    await one(key, VARIANTS[key]);
  }
  const el = document.createElement('pre');
  el.id = 'e2e-results';
  el.textContent = JSON.stringify({ key, records });
  document.body.appendChild(el);
  try { parent.postMessage({ type: 'e2e:results', key, records }, '*'); } catch (e) { /* host closed */ }
}
export default function App() {
  const path = useRoute();
  const key = VARIANTS[path] ? path : (path === '/' ? '/' : null);
  if (key) runKey(key);
  return html\`<div class="page">E2E</div>\`;
}
`;

function reqOrigin(req) {
  try { const u = new URL(req.url); if (u.origin && u.origin !== "null") return u.origin; } catch { /* fall through */ }
  const host = req.headers.get("host");
  return host ? `${req.headers.get("x-forwarded-proto") || "https"}://${host}` : null;
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const op = String(body.op || "");

    if (op === "setup") {
      const platformUser = await base44.auth.me().catch(() => null);
      if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const stamp = Date.now();
      const uid = crypto.randomUUID().slice(0, 8);
      const ws = await svc.entities.Workspace.create({ name: "Host Auth Bridge E2E", owner_id: platformUser.id, credits_balance: 0 });
      const slug = `hostauth-e2e-${stamp}`;
      const cred = {
        email: `hostauth-${uid}@example.com`,
        password: PASSWORD,
        new_password: NEW_PASSWORD,
        invite_email: `hostauth-inv-${uid}@example.com`,
        admin_invite_email: `hostauth-adm-${uid}@example.com`,
      };
      let projectId = null;
      let a;
      try {
        a = await createDeployedApp(svc, {
          workspace_id: ws.id, name: "Host Auth E2E", slug, deployed_by: platformUser.id,
          files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP_SOURCE(cred)], ["styles.css", MINIMAL_STYLES]],
          on_project_created: (p) => { projectId = p.id; },
        });
        const live = (a.run && a.run.deployment && a.run.deployment.status) || null;
        if (live !== "LIVE") return Response.json({ ok: false, error: `Deployment did not reach LIVE (status=${live})`, workspace_id: ws.id, project_id: projectId }, { status: 500 });
        await signUpWithSession(svc, a.project.id, { email: cred.email, password: cred.password, full_name: "E2E User" }, { ip: "203.0.113.60" });
      } catch (e) {
        return Response.json({ ok: false, error: safeError(e), workspace_id: ws.id, project_id: projectId }, { status: 500 });
      }
      return Response.json({
        ok: true, slug, project_id: a.project.id, workspace_id: ws.id,
        email: cred.email, password: cred.password, new_password: cred.new_password,
        invite_email: cred.invite_email, admin_invite_email: cred.admin_invite_email,
      });
    }

    if (op === "setup_redirect") {
      const platformUser = await base44.auth.me().catch(() => null);
      if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const stamp = Date.now();
      const ws = await svc.entities.Workspace.create({ name: "Host Auth Redirect E2E", owner_id: platformUser.id, credits_balance: 0 });
      const slug = `hostauth-rl-e2e-${stamp}`;
      const origin = reqOrigin(req);
      if (!origin) return Response.json({ ok: false, error: "Request origin could not be resolved", workspace_id: ws.id, project_id: null }, { status: 500 });
      let projectId = null;
      let a;
      try {
        a = await createDeployedApp(svc, {
          workspace_id: ws.id, name: "Host Auth Redirect E2E", slug, deployed_by: platformUser.id,
          files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", REDIRECT_APP_SOURCE(origin, slug)], ["styles.css", MINIMAL_STYLES]],
          on_project_created: (p) => { projectId = p.id; },
        });
      } catch (e) {
        return Response.json({ ok: false, error: safeError(e), workspace_id: ws.id, project_id: projectId }, { status: 500 });
      }
      const live = (a.run && a.run.deployment && a.run.deployment.status) || null;
      if (live !== "LIVE") return Response.json({ ok: false, error: `Deployment did not reach LIVE (status=${live})`, workspace_id: ws.id, project_id: projectId }, { status: 500 });
      return Response.json({ ok: true, slug, project_id: a.project.id, workspace_id: ws.id, base: `${origin}/app/${slug}` });
    }

    if (op === "register_user") {
      const platformUser = await base44.auth.me().catch(() => null);
      if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const project = body.project_id ? await svc.entities.Project.get(String(body.project_id)).catch(() => null) : null;
      if (!project) return forbidden();
      const gate = await requireFixtureWorkspace(svc, platformUser, project.workspace_id);
      if (gate.denied) return gate.denied;
      if (!gate.projects.some((p) => p.id === project.id)) return forbidden();
      const email = String(body.email || "").trim();
      if (!email) return Response.json({ error: "An email is required" }, { status: 400 });
      await signUpWithSession(svc, project.id, { email, password: PASSWORD, full_name: "Redirect E2E" }, { ip: "203.0.113.60" });
      return Response.json({ ok: true, email, password: PASSWORD });
    }

    if (op === "cleanup") {
      const platformUser = await base44.auth.me().catch(() => null);
      if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
      // body.project_ids is ignored: projects are derived from the verified workspace only.
      const gate = await requireFixtureWorkspace(svc, platformUser, body.workspace_id);
      if (gate.denied) return gate.denied;
      const plan = [];
      for (const p of gate.projects) {
        for (const entity of ["AppSession", "AppAuthToken", "AppUser", "AuditLog", "DeploymentArtifact", "Deployment", "ProjectVersion", "ProjectFile"]) {
          plan.push({ entity, query: { project_id: p.id } });
        }
      }
      for (const entity of ["RateLimitBucket", "AuditLog", "Project"]) plan.push({ entity, query: { workspace_id: gate.ws.id } });
      plan.push({ entity: "Workspace", query: { id: gate.ws.id, owner_id: platformUser.id, name: gate.ws.name } });
      const r = await cleanupAndVerify(svc, plan);
      return Response.json({ ok: r.ok, detail: cleanupDetail(r) }, { status: r.ok ? 200 : 500 });
    }

    return Response.json({ error: `Unsupported op ${op}` }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: safeError(e) }, { status: 500 });
  }
}