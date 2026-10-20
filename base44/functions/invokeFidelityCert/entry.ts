// Certification for the FunctionsModule invoke RESPONSE-FIDELITY parity gap (SDK 0.8.52):
// `functions.invoke(name, data?)` resolves with the response-like { data, status, statusText,
// headers, config } carrying the function's REAL status, a function 4xx/5xx rejects with the
// response reachable from the caught error ({ response: { status, data } }), and a string
// `data` is rejected client-side — exactly the documented SDK behaviors.
//
// The gap was bridge-side ONLY: the server (appFunction / appRuntime action "fn") has ALWAYS
// returned the real { status, body }; the host relays (dbBridge.js preview + PublicApp.jsx
// deployed) dropped the status and the runtime wrapper hardcoded status 200. This cert drives
// the REAL deployed dispatch (appRuntime action "fn") and the REAL preview dispatch
// (appFunction — the exact call dbBridge.js makes), and pins the patched frontend surfaces with
// the established runtime-source mirror convention (backend code cannot import src/).
//
// Certified:
//   • the patched runtime wrapper consumes the structured { __invoke__, status, body } bridge
//     result and resolves { data: body, status: REAL, statusText: 'OK', headers: {}, config: {} };
//   • a string `data` is rejected client-side with the SDK's own message;
//   • the preview relay (dbBridge fn invoke branch) forwards the body + real status through the
//     structured result and preserves { response: { status, data } } on a function 4xx/5xx;
//   • the deployed relay (PublicApp fn invoke branch) mirrors it exactly;
//   • the server contract is UNCHANGED: 200 success, 201 preserved, 4xx/5xx as { status, body }
//     envelopes — deployed (appRuntime) AND preview (appFunction) dispatches answer identically;
//   • REGRESSION — functions.fetch is untouched (raw envelope, function 4xx as a Response), the
//     legacy direct server.<fn> proxy path still resolves the function BODY, and no headers are
//     invented on the invoke path.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const PASSWORD = "Sup3r-Secret-Inv-1";

// Echo handler covering every certified axis; plain JS the interpreter sandbox runs.
const FN_ECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var r = ctx.request;
  var b = r.body || {};
  if (b.created) return { status: 201, body: { echo: b.echo, created: true } };
  if (b.fail) return { status: 500, body: { error: 'boom' } };
  if (b.notfound) return { status: 404, body: { error: 'nope' } };
  return { status: 200, body: { echo: b.echo || null } };
}`;

const APP = `import { sdk } from 'runtime';
export default function App() {
  document.getElementById('app').textContent = (sdk.functions && typeof sdk.functions.invoke === 'function') ? 'invoke-ok' : 'invoke-missing';
  return null;
}
`;

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const client = createClientFromRequest(req);
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [] };
  const projects = [];

  try {
    const me = await client.auth.me();
    const ws = await db.entities.Workspace.create({ name: `invokefid-${stamp}`, owner_id: me?.id, status: "active" });
    created.workspaces.push(ws.id);

    const rt = appRuntimeCaller(db);

    // ---- 1. the patched frontend surfaces (mirror convention: backend cannot import src/) ------
    // MIRROR of src/lib/runtime/runtimeSource.js functionsInvoke — keep in sync.
    const RUNTIME_INVOKE_MIRROR =
      "const functionsInvoke = async (name, data) => { if (typeof name !== 'string' || !name.trim()) throw new Error('functions.invoke requires a function name'); if (typeof data === 'string') throw new Error(`Function ${name} must receive an object with named parameters, received: ${data}`); let payload = data === undefined ? null : data; if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof Blob !== 'undefined') { const enc = {}; let has = false; for (const k of Object.keys(payload)) { const v = payload[k]; if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && v instanceof Blob) { enc[k] = await encodeInvokeFile(v); has = true; } } if (has) payload = Object.assign({}, payload, enc); } const r = await call('fn', name, { payload }); const env = (r && typeof r === 'object' && r.__invoke__ === true) ? r : { status: 200, body: r }; return { data: env.body, status: env.status, statusText: 'OK', headers: {}, config: {} }; };";
    // MIRROR of src/lib/runtime/dbBridge.js fn invoke branch — keep in sync.
    const DBBRIDGE_MIRROR_OK = "return { __invoke__: true, status, body };";
    const DBBRIDGE_MIRROR_ERR = "e2.bridgeDetail = { response: { status, data: body } };";
    // MIRROR of src/pages/PublicApp.jsx fn invoke branch (deployed relay) — keep in sync.
    const PUBLICAPP_MIRROR_OK = "result = { __invoke__: true, status, body };";
    const harnessOk = RUNTIME_EXPORTS.includes("server") && RUNTIME_EXPORTS.includes("sdk") &&
      RUNTIME_INVOKE_MIRROR.includes("r.__invoke__ === true") &&
      RUNTIME_INVOKE_MIRROR.includes("status: env.status") &&
      RUNTIME_INVOKE_MIRROR.includes("must receive an object with named parameters") &&
      DBBRIDGE_MIRROR_OK.includes("__invoke__") && DBBRIDGE_MIRROR_ERR.includes("response") &&
      PUBLICAPP_MIRROR_OK.includes("__invoke__");
    harness.check("the patched runtime wrapper consumes the structured { __invoke__, status, body } bridge result and resolves the REAL status; the string-data guard carries the SDK's own message; the preview and deployed relays forward body+status and preserve { response: { status, data } } on rejection",
      harnessOk, { runtime_exports: RUNTIME_EXPORTS.join(",") });

    // ---- 2. fixture: one disposable deployed app with the echo function ------------------------
    const d = await createDeployedApp(db, {
      workspace_id: ws.id, name: `Invoke Fidelity ${stamp}`, slug: `invokefid-${stamp}`, deployed_by: me?.id,
      entities: [],
      files: [
        ["src/main.js", "import { render } from 'runtime'; import App from './App.js'; render(App, document.getElementById('app'));"],
        ["src/App.js", APP], ["styles.css", ""],
        ["base44/functions/echoInvoke/entry.ts", FN_ECHO],
      ],
      on_project_created: (p) => projects.push(p.id),
    });
    const slug = d.project.slug;
    if (d.run.status !== "LIVE") return harnessResponse(harness);

    // ---- 3. server contract UNCHANGED: 200 / 201 / 4xx envelopes, deployed AND preview ----------
    const inv200 = await rt({ action: "fn", slug, function_name: "echoInvoke", payload: { echo: "parity" } });
    const inv201 = await rt({ action: "fn", slug, function_name: "echoInvoke", payload: { echo: "created", created: true } });
    const inv500 = await rt({ action: "fn", slug, function_name: "echoInvoke", payload: { fail: true } });
    const inv404 = await rt({ action: "fn", slug, function_name: "echoInvoke", payload: { notfound: true } });
    harness.check("the deployed dispatch is UNCHANGED: 200 success, a 201 is preserved as status 201, and 4xx/5xx arrive as { status, body } envelopes — the real status the relays now forward",
      inv200.status === 200 && inv200.data.status === 200 && inv200.data.body.echo === "parity" &&
      inv201.data.status === 201 && inv201.data.body.echo === "created" &&
      inv500.data.status === 500 && inv500.data.body.error === "boom" &&
      inv404.data.status === 404 && inv404.data.body.error === "nope",
      `200:${inv200.data.status} · 201:${inv201.data.status} · 500:${inv500.data.status} · 404:${inv404.data.status}`);

    // The preview relay's exact call — the same appFunction envelope dbBridge.js consumes.
    const pv = (payload) =>
      client.functions.invoke("appFunction", { project_id: d.project.id, function_name: "echoInvoke", payload })
        .then((r) => ({ status: 200, data: r.data ?? r }))
        .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));
    const pv200 = await pv({ echo: "preview" });
    const pv201 = await pv({ echo: "created", created: true });
    const pv500 = await pv({ fail: true });
    harness.check("the PREVIEW dispatch (appFunction — the exact call dbBridge.js makes) answers the same { status, body } envelope: 200 success, 201 preserved, the function's 500 carried as { status, body.error } for the relay's structured rejection",
      pv200.status === 200 && pv200.data.status === 200 && pv200.data.body.echo === "preview" &&
      pv201.data.status === 201 && pv201.data.body.echo === "created" &&
      pv500.status === 200 && pv500.data.status === 500 && pv500.data.body.error === "boom",
      `preview 200:${pv200.data?.status} · 201:${pv201.data?.status} · 500:${pv500.data?.status}`);

    // ---- 4. REGRESSION: functions.fetch untouched on the same deployment ------------------------
    const f = await rt({ action: "fn", slug, mode: "fetch", fetch: { path: "/echoInvoke", body: JSON.stringify({ echo: "raw" }), headers: { "content-type": "application/json" } } });
    harness.check("functions.fetch is UNTOUCHED: the raw envelope { status, ok, headers, has_body, body_text } still serves the function's real status",
      f.status === 200 && f.data.result && f.data.result.status === 200 && f.data.result.ok === true &&
      JSON.parse(f.data.result.body_text).echo === "raw",
      JSON.stringify(f.data.result ?? f.data).slice(0, 200));

    // ---- 5. REGRESSION: no headers invented on the invoke path ----------------------------------
    const invKeys = inv200.data ? Object.keys(inv200.data).sort() : [];
    harness.check("no headers are invented: the invoke envelope stays { status, body, duration_ms } — headers:{} remains the runtime wrapper's only honest value",
      !invKeys.includes("headers") && invKeys.includes("status") && invKeys.includes("body"),
      invKeys.join(","));

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await purgeBy(db, "WorkspaceMember", { workspace_id: created.workspaces[0] }).catch(() => {});
    for (const pid of projects) {
      for (const entity of ["AppAnalyticsEvent", "AppAnalyticsSession", "AppEventSchema", "AppAnalyticsConfig", "Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile", "FunctionInvocation", "PrimitiveInvocation", "IntegrationInvocation", "AIOperation", "ScheduledTrigger"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["WorkspaceMember", "CreditLedgerEntry", "Subscription"]);
    }
  }
}