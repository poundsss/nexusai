// Minimal certification for the DOCUMENTED FunctionsModule invoke surface (SDK 0.8.51):
// sdk.functions.invoke(functionName, data?) → axios-like response whose `.data` carries the
// function's returned JSON; a function status >= 400 REJECTS the promise. This suite certifies
// the SERVER half of that contract — the executor result `{ status, body }` that the client
// wrapper maps onto `.data`/rejection — through the REAL deployed runtime (appRuntime action fn,
// its real HTTP surface) and the SAME existing executor, with NO new execution subsystem:
//
//   • success body → the source of `.data` (invoke round-trip through the deployed runtime);
//   • a function's own 500 → the envelope the client bridge rejects on (status >= 400);
//   • a missing function → an INFRASTRUCTURE 404 refusal (rejects, never a Response);
//   • functions.fetch is UNTOUCHED (same deployment, raw envelope still works);
//   • no credits move in either pool (no invented invoke charge);
//   • the deployed artifact ships the generated surface that names sdk.functions.invoke.
//
// NOT claimed (pinned in INVOKE_CONTRACT): multipart/File parameters (DOCUMENTED — CONFIRMED
// GAP, refused), rejection error shape (NEXUSAI-DERIVED — Base44 publishes none).
// asServiceRole.functions.invoke was RESOLVED by G-B on the backend function-runtime ctx —
// certified separately (appFunctionsServiceRoleInvokeParityTest); this suite stays frontend.
// Streaming/SSE and fetch semantics are certified by appFunctionsFetchParityTest and are not
// reopened here.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeAgentProject } from "../../shared/appAgentTestFixtures.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { invokePace, probeCreditDeltas } from "../../shared/invokeParityHelpers.ts";
import { canonicalFunctionPath } from "../../shared/functionPaths.ts";
import { packFileContent } from "../../shared/blobStore.ts";
import { createDeployedApp, appRuntimeCaller, MINIMAL_MAIN, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { ENTRY_FILE, RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { currentLiveDeployment, loadArtifactPayload } from "../../shared/deploy.ts";

const INVOKE_CONTRACT = {
  signature: "DOCUMENTED — invoke(functionName, data?) → axios-like response; the function's JSON is on .data",
  data_shape: "NEXUSAI-DERIVED — { data, status: 200, statusText: 'OK', headers: {}, config: {} } on success (Base44 publishes only `.data`)",
  error: "DERIVED — a function status >= 400 REJECTS the promise (host bridge throws; rejection shape NEXUSAI-DERIVED — Base44 publishes none)",
  multipart: "CONFIRMED GAP — File parameters are DOCUMENTED in the SDK but NOT implemented (refused by the JSON bridge; no silent coercion)",
  service_role: "RESOLVED (G-B) — implemented on the BACKEND function-runtime ctx as asServiceRole.functions.invoke (service role, same executor; certified by appFunctionsServiceRoleInvokeParityTest). NOT part of this FRONTEND sdk.functions surface",
  reserved_names: "NEXUSAI-DERIVED — 'fetch' and 'invoke' are the proxy's only reserved names",
  transport: "ALREADY COVERED — deployed (appRuntime action fn) and preview (appFunction/previewData) ride the SAME executor; project isolation certified in the fetch suite",
  billing: "no credits move for invoke — no invented charge",
};

// One echo handler covering every certified axis; plain JS the interpreter sandbox runs.
const FN_ECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var r = ctx.request;
  if (r.body && r.body.fail) return { status: 500, body: { error: 'boom' } };
  if (r.body && r.body.notfound) return { status: 404, body: { error: 'nope' } };
  return { status: 200, body: { echo: r.body ? r.body.echo : null } };
}`;

// The generated app names the surface it relies on — the artifact proves the SDK alias ships.
const APP = `import { sdk } from 'runtime';
export default function App() {
  document.getElementById('app').textContent = (typeof sdk === 'object' && sdk.functions && typeof sdk.functions.invoke === 'function') ? 'invoke-ok' : 'invoke-missing';
  return null;
}
`;

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  const pace = invokePace;
  const FN_PATH = canonicalFunctionPath("echoInvoke");

  try {
    const plan = await makeBillingPlan(db, created, `p9fi${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9fi${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "p9fi");

    // Scratch function source — the SAME file the deployment packages.
    await db.entities.ProjectFile.create({ project_id: P.id, path: FN_PATH, ...(await packFileContent(db, FN_PATH, FN_ECHO)) });

    // ---- 1. the server half of invoke: the executor result that becomes `.data` -------------
    const ok = await executeProjectFunction(db, {
      project: P, entities: [], name: "echoInvoke", source: FN_ECHO,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { echo: "invoke-parity" } },
    });
    harness.check("invoke success: the executor result is { status: 200, body } — the value the client wrapper maps onto .data",
      ok.status === 200 && ok.body && ok.body.echo === "invoke-parity", JSON.stringify(ok.body));

    const fail = await executeProjectFunction(db, {
      project: P, entities: [], name: "echoInvoke", source: FN_ECHO,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { fail: true } },
    });
    harness.check("invoke >=400: a function's own 500 arrives as the { status, body.error } envelope the client bridge rejects on",
      fail.status === 500 && fail.body && fail.body.error === "boom", JSON.stringify(fail.body));

    // ---- 2. deployed round-trip through the REAL public runtime -----------------------------
    const d = await createDeployedApp(db, {
      workspace_id: A.ws.id, name: `p9fi-invoke ${stamp}`, slug: `p9fi-${stamp}`, deployed_by: A.user.id,
      entities: [],
      files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP], ["styles.css", MINIMAL_STYLES], [FN_PATH, FN_ECHO]],
      on_project_created: (p) => projectIds.push(p.id),
    });
    const slug = d.project.slug;
    harness.check("surface: the deployed app goes LIVE and its artifact names sdk.functions.invoke (the alias ships with server+sdk)",
      d.run.status === "LIVE" && RUNTIME_EXPORTS.includes("server") && RUNTIME_EXPORTS.includes("sdk"), `${d.run.status}`);
    if (d.run.status !== "LIVE") return harnessResponse(harness);
    const live = await currentLiveDeployment(db, d.project, "production");
    const payload = await loadArtifactPayload(await db.entities.DeploymentArtifact.get(live.artifact_id));
    harness.check("surface: the artifact's client files carry the generated invoke usage; the function source stays server-side",
      payload.client_files.some((f) => f.path === "src/App.js" && f.content.includes("sdk.functions.invoke")) &&
      (payload.functions || []).some((f) => f.name === "echoInvoke"),
      `functions in artifact: ${(payload.functions || []).map((f) => f.name).join(",")}`);

    const runtime = appRuntimeCaller(db);
    const inv = await runtime({ action: "fn", slug, function_name: "echoInvoke", payload: { echo: "parity" } });
    await pace();
    harness.check("invoke success (deployed): the REAL runtime returns { status: 200, body.echo } for the wrapper's .data",
      inv.ok === true && inv.data.status === 200 && inv.data.body && inv.data.body.echo === "parity",
      JSON.stringify(inv.data).slice(0, 160));

    const bad = await runtime({ action: "fn", slug, function_name: "echoInvoke", payload: { fail: true } });
    await pace();
    harness.check("invoke >=400 (deployed): the function's 500 travels as { status, body.error } — a Response-shape envelope, never a bridge success",
      bad.ok === true && bad.data.status === 500 && bad.data.body && bad.data.body.error === "boom",
      JSON.stringify(bad.data).slice(0, 160));

    const missing = await runtime({ action: "fn", slug, function_name: "nopeFn", payload: {} });
    await pace();
    harness.check("invoke missing function (deployed): an INFRASTRUCTURE 404 refusal — it rejects (never a Response for the caller)",
      missing.ok === false && Number(missing.status) === 404, JSON.stringify(missing).slice(0, 160));

    // ---- 3. fetch is UNTOUCHED on the same deployment ---------------------------------------
    const f = await runtime({ action: "fn", slug, mode: "fetch", fetch: { path: "/echoInvoke?x=1" } });
    await pace();
    harness.check("fetch untouched: the same deployment still serves the raw envelope { status, ok, headers, has_body, body_text }",
      f.ok === true && f.data.result && f.data.result.status === 200 && f.data.result.ok === true &&
      JSON.parse(f.data.result.body_text).echo === null, JSON.stringify(f.data.result ?? f.data).slice(0, 200));

    // ---- 4. billing: no credits move ---------------------------------------------------------
    const deltas = await probeCreditDeltas(db, A.ws.id, () =>
      runtime({ action: "fn", slug, function_name: "echoInvoke", payload: { echo: "bill" } }).then(() => pace()));
    harness.check("billing: invoke moves NO credits in either pool (no invented charge)",
      deltas.messageDelta === 0 && deltas.integrationDelta === 0,
      `message Δ${deltas.messageDelta} · integration Δ${deltas.integrationDelta}`);

    // ---- 5. certification boundary pinned -----------------------------------------------------
    harness.check("boundary: every undocumented semantic stays pinned — multipart remains a CONFIRMED GAP, service-role is RESOLVED (G-B, backend ctx surface only), nothing invented",
      INVOKE_CONTRACT.multipart.includes("CONFIRMED GAP") && INVOKE_CONTRACT.service_role.includes("RESOLVED (G-B)")
        && INVOKE_CONTRACT.error.includes("REJECTS") && INVOKE_CONTRACT.billing.includes("no invented charge"),
      JSON.stringify(INVOKE_CONTRACT).slice(0, 240));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const entity of ["Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Build", "FunctionInvocation", "AppRecord", "AppEntity", "AppSession"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "WorkspaceMember", "Project", "UsageEvent", "AIOperation"]);
    }
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9fi" } }).catch(() => {});
  }
}