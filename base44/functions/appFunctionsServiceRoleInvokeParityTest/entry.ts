// G-B certification — the DOCUMENTED service-role FunctionsModule invoke (SDK 0.8.51/0.8.52):
// base44.asServiceRole.functions.invoke(functionName, data?) executed from backend code with
// service-role authorization. Certified through the SAME executor (no new runtime, no new auth
// subsystem), through BOTH the direct executor half and a LIVE deployed app:
//   • success → the axios-like envelope { data, status: 200, statusText, headers, config },
//     .data carrying the target's JSON;
//   • the target's status >= 400 REJECTS — the caller's try/catch sees the refusal, with
//     .response carrying the target's { status, data } (NEXUSAI-DERIVED field set);
//   • service role: the inner execution's ctx.user is null even when the caller HAD a user,
//     and the inner invocation records trigger "function" / a service identity;
//   • missing target → a deterministic refusal, never silent;
//   • project isolation: another project's function name does not resolve;
//   • bounded: a self-recursive chain terminates at the depth cap (exact invocation-row count,
//     no hang), and at most 8 inner calls happen in one execution (the 9th refuses fail-closed);
//   • billing: no credits move in either pool;
//   • deployed round-trip: a LIVE app's caller function reaches its inner function;
//   • frontend surface UNTOUCHED: the frontend runtime exports ship no asServiceRole.
// NOT claimed: streaming; functions.fetch changes (G-C untouched); multipart changes (G-A
// machinery untouched — file descriptors restore through the existing executor path as before);
// timeouts/quotas (the inner execution re-resolves the same server-side defaults, unchanged).
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

// The inner echo: also fails on demand (>=400 axis) and reports the user it saw (service-role axis).
const FN_ECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var b = ctx.request.body || {};
  if (b.fail) return { status: 500, body: { error: 'boom' } };
  return { status: 200, body: { echo: b.echo === undefined ? null : b.echo, user_seen: ctx.user ? ctx.user.id : null } };
}`;

// The caller: exercises the documented surface, keeps every outcome inspectable. Plain JS the
// interpreter sandbox runs — no secrets, no external calls, no credits.
const FN_CALLER = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var b = ctx.request.body || {};
  var out = {
    caller_user: ctx.user ? ctx.user.id : null,
    has_sr_surface: !!(ctx.asServiceRole && ctx.asServiceRole.functions && typeof ctx.asServiceRole.functions.invoke === 'function'),
    agents_alias_same: !!(ctx.asServiceRole && ctx.agents && ctx.asServiceRole.agents === ctx.agents),
    results: [],
  };
  var calls = b.calls || [];
  for (var i = 0; i < calls.length; i++) {
    var c = calls[i];
    try {
      var r = await ctx.asServiceRole.functions.invoke(c.target, c.payload === undefined ? {} : c.payload);
      out.results.push({ name: c.name, rejected: false, status: r.status, statusText: r.statusText, data: r.data, hasConfig: !!r.config, hasHeaders: !!r.headers });
    } catch (e) {
      out.results.push({ name: c.name, rejected: true, code: e.code || null, message: String(e.message || e).slice(0, 160), response: e.response ? { status: e.response.status, data: e.response.data } : null });
    }
  }
  return { status: 200, body: out };
}`;

// A self-invoking function: the depth axis. Uncaught refusal — the chain must terminate.
const FN_SELF = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var b = ctx.request.body || {};
  if (!b.go) return { status: 200, body: { stop: true } };
  return await ctx.asServiceRole.functions.invoke('gbSelf', { go: true });
}`;

const APP = `import { sdk } from 'runtime';
export default function App() {
  document.getElementById('app').textContent = 'gb-ok';
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
  const ECHO_PATH = canonicalFunctionPath("gbEcho");
  const CALLER_PATH = canonicalFunctionPath("gbCaller");
  const SELF_PATH = canonicalFunctionPath("gbSelf");
  const SIBLING_PATH = canonicalFunctionPath("gbSibling");

  try {
    const plan = await makeBillingPlan(db, created, `p9gb${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9gb${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "p9gb");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p9gb2");

    const put = async (projectId, path, source) =>
      db.entities.ProjectFile.create({ project_id: projectId, path, ...(await packFileContent(db, path, source)) });
    await put(P.id, ECHO_PATH, FN_ECHO);
    await put(P.id, CALLER_PATH, FN_CALLER);
    await put(P.id, SELF_PATH, FN_SELF);
    await put(P2.id, SIBLING_PATH, FN_ECHO);

    // ---- 1. success + service role + surface, in ONE caller execution ------------------------
    const ok = await executeProjectFunction(db, {
      project: P, entities: [], name: "gbCaller", source: FN_CALLER,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: {
        method: "POST", query: {}, headers: {},
        body: {
          calls: [
            { name: "ok", target: "gbEcho", payload: { echo: "sr" } },
            { name: "boom", target: "gbEcho", payload: { fail: true } },
            { name: "missing", target: "gbMissing", payload: {} },
            { name: "cross", target: "gbSibling", payload: {} },
          ],
        },
      },
      user: { id: "u-caller", roles: [] },
    });
    const B = ok.body || {};
    const r = (n) => (B.results || [])[n] || null;
    harness.check("G-B surface: the executing ctx exposes ctx.asServiceRole.functions.invoke; agents is the SAME module aliased",
      B.has_sr_surface === true && B.agents_alias_same === true,
      JSON.stringify({ has_sr_surface: B.has_sr_surface, agents_alias_same: B.agents_alias_same }));
    harness.check("G-B success: the axios-like envelope arrives — .data carries the target's JSON, status 200, statusText 'OK', headers + config present",
      ok.status === 200 && r(0) && r(0).rejected === false && r(0).status === 200 && r(0).statusText === "OK"
        && r(0).data && r(0).data.echo === "sr" && r(0).hasConfig === true && r(0).hasHeaders === true,
      JSON.stringify(r(0)));
    harness.check("G-B service role: the inner execution ran with ctx.user = null even though the caller HAD a user",
      B.caller_user === "u-caller" && r(0) && r(0).data && r(0).data.user_seen === null,
      `caller=${B.caller_user} inner_user=${r(0) && r(0).data && r(0).data.user_seen}`);
    harness.check("G-B >=400: the target's 500 REJECTS — the caller's catch sees e.response carrying the target's { status, data }",
      r(1) && r(1).rejected === true && r(1).response && r(1).response.status === 500 && r(1).response.data && r(1).response.data.error === "boom",
      JSON.stringify(r(1)));
    harness.check("G-B missing: an unresolvable target refuses deterministically — rejected, never silent",
      r(2) && r(2).rejected === true && (r(2).message || "").includes("does not exist"),
      JSON.stringify(r(2)));
    harness.check("G-B isolation: another project's function name does not resolve — never cross-project execution",
      r(3) && r(3).rejected === true && (r(3).message || "").includes("does not exist"),
      JSON.stringify(r(3)));

    // ---- 2. the inner invocation's recorded identity ------------------------------------------
    const innerRows = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "gbEcho" }, "created_date", 5);
    harness.check("G-B identity: inner invocations record trigger 'function' with a service identity (kind 'service', no user)",
      innerRows.length >= 2 && innerRows.some((x) => x.trigger === "function" && x.identity && x.identity.kind === "service" && !x.identity.app_user_id),
      JSON.stringify(innerRows.slice(0, 2).map((x) => ({ trigger: x.trigger, identity: x.identity }))));

    // ---- 3. bounded: per-execution call limit --------------------------------------------------
    const calls10 = [];
    for (let i = 0; i < 10; i++) calls10.push({ name: `c${i}`, target: "gbEcho", payload: { echo: i } });
    const limit = await executeProjectFunction(db, {
      project: P, entities: [], name: "gbCaller", source: FN_CALLER,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { calls: calls10 } },
    });
    const l7 = (limit.body.results || [])[7] || null;
    const l8 = (limit.body.results || [])[8] || null;
    harness.check("G-B bounded: at most 8 inner invocations per execution — the 9th refuses fail-closed with FUNCTION_INVOKE_LIMIT",
      l7 && l7.rejected === false && l8 && l8.rejected === true && l8.code === "FUNCTION_INVOKE_LIMIT",
      `c8=${JSON.stringify(l8)}`);

    // ---- 4. bounded: recursion depth ------------------------------------------------------------
    const depth = await executeProjectFunction(db, {
      project: P, entities: [], name: "gbSelf", source: FN_SELF,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { go: true } },
    });
    const selfRows = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "gbSelf" }, "created_date", 10);
    harness.check("G-B bounded: a self-recursive chain terminates deterministically — exactly 4 executions (outer + 3 chained), no hang, the depth refusal is recorded",
      depth.status === 500 && selfRows.length === 4 && selfRows.some((x) => (x.error_message || "").includes("depth limit")),
      `status=${depth.status} rows=${selfRows.length}`);

    // ---- 5. billing: no credits move ------------------------------------------------------------
    const deltas = await probeCreditDeltas(db, A.ws.id, () =>
      executeProjectFunction(db, {
        project: P, entities: [], name: "gbCaller", source: FN_CALLER,
        trigger: "frontend", requestId: crypto.randomUUID(),
        request: { method: "POST", query: {}, headers: {}, body: { calls: [{ name: "ok", target: "gbEcho", payload: { echo: "bill" } }] } },
      }));
    harness.check("G-B billing: a service-role invoke moves NO credits in either pool (no invented charge)",
      deltas.messageDelta === 0 && deltas.integrationDelta === 0,
      `message Δ${deltas.messageDelta} · integration Δ${deltas.integrationDelta}`);

    // ---- 6. deployed round-trip through the REAL public runtime ---------------------------------
    const d = await createDeployedApp(db, {
      workspace_id: A.ws.id, name: `p9gb-live ${stamp}`, slug: `p9gb-${stamp}`, deployed_by: A.user.id,
      entities: [],
      files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP], ["styles.css", MINIMAL_STYLES], [ECHO_PATH, FN_ECHO], [CALLER_PATH, FN_CALLER]],
      on_project_created: (p) => projectIds.push(p.id),
    });
    harness.check("G-B deployed surface: the LIVE app serves a caller that uses asServiceRole.functions.invoke",
      d.run.status === "LIVE", `${d.run.status}`);
    if (d.run.status === "LIVE") {
      const runtime = appRuntimeCaller(db);
      const inv = await runtime({
        action: "fn", slug: d.project.slug, function_name: "gbCaller",
        payload: { calls: [
          { name: "ok", target: "gbEcho", payload: { echo: "live" } },
          { name: "boom", target: "gbEcho", payload: { fail: true } },
        ] },
      });
      await pace();
      const live0 = inv.ok && inv.data && inv.data.body && (inv.data.body.results || [])[0];
      const live1 = inv.ok && inv.data && inv.data.body && (inv.data.body.results || [])[1];
      harness.check("G-B deployed round-trip: the LIVE app's caller reaches its inner function (success AND rejection both inspectable)",
        live0 && live0.rejected === false && live0.data && live0.data.echo === "live"
          && live1 && live1.rejected === true && live1.response && live1.response.status === 500,
        JSON.stringify((inv.data && inv.data.body && inv.data.body.results) || inv.data).slice(0, 240));
    }

    // ---- 7. frontend surface untouched ----------------------------------------------------------
    harness.check("G-B boundary: the FRONTEND runtime surface ships NO asServiceRole — the resolved surface is backend-only",
      RUNTIME_EXPORTS.includes("server") && RUNTIME_EXPORTS.includes("sdk") && !RUNTIME_EXPORTS.includes("asServiceRole"),
      RUNTIME_EXPORTS.join(","));

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
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9gb" } }).catch(() => {});
  }
}