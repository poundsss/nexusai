// Focused certification for #31E — Authorized Integration API.
//
// The endpoint's exact path is executed INLINE through the shared integrationApiHelpers module
// (same loadAuthorizedProject gate, same shared services, same order). Only the network boundary
// of test_call's upstream is scripted, and every upstream hit is counted so "respects
// breaker/quota/rate-limit" is proven rather than assumed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy } from "../../shared/testHarness.ts";
import { svcOf, mockJson, makeInlineIntegrationApi } from "../../shared/integrationApiHelpers.ts";
import { setDnsLookupForTests } from "../../shared/externalTools.ts";

const HOST = "api.example.com";
const SECRET_VALUE = "sk_live_cert_must_never_leak_31e_9f3a";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = svcOf(base44);
  const h = createHarness();
  const realFetch = globalThis.fetch;
  let workspace = null, viewerWs = null, outWs = null;
  let project = null, otherProj = null, viewerProj = null, outProj = null;

  const hits = {};
  // DNS is scripted alongside fetch: the pre-flight resolves the fixture host through this
  // hook (a public address, like a real upstream would), so the scripted fetch below stays
  // the only network path the engine ever takes.
  setDnsLookupForTests((host) => {
    if (host !== HOST) throw new Error(`unscripted host ${host}`);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== HOST) return realFetch(url, options);
    const key = `${u.hostname}${u.pathname}`;
    hits[key] = (hits[key] || 0) + 1;
    if (u.pathname === "/v1/ok") return mockJson({ state: "ok" });
    if (u.pathname === "/v1/down") return mockJson({ error: "boom" }, 503);
    if (u.pathname === "/v1/limited") return mockJson({ error: "slow down" }, 429, { "retry-after": "0" });
    return mockJson({ error: "unexpected path" }, 500);
  };

  const api = makeInlineIntegrationApi(base44, svc);

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `IntApi ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    viewerWs = await svc.entities.Workspace.create({ name: `IntApi Viewer ${Date.now()}`, owner_id: `other_owner_${Date.now()}`, credits_balance: 0 });
    outWs = await svc.entities.Workspace.create({ name: `IntApi Out ${Date.now()}`, owner_id: `yet_another_${Date.now()}`, credits_balance: 0 });
    await svc.entities.WorkspaceMember.create({ workspace_id: viewerWs.id, email: "caller@intapi.test", user_id: caller.id, role: "viewer", status: "active" });

    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `IntApi ${Date.now()}`, slug: `ia-${Date.now()}` });
    otherProj = await svc.entities.Project.create({ workspace_id: workspace.id, name: `IntApi Other ${Date.now()}`, slug: `ia-other-${Date.now()}` });
    viewerProj = await svc.entities.Project.create({ workspace_id: viewerWs.id, name: `IntApi Viewer ${Date.now()}`, slug: `iav-${Date.now()}` });
    outProj = await svc.entities.Project.create({ workspace_id: outWs.id, name: `IntApi Out ${Date.now()}`, slug: `iao-${Date.now()}` });

    const okDef = { name: "poke", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "none" }, operations: [{ name: "go", method: "GET", path: "/ok" }] };
    const secretDef = { name: "secret", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "bearer", secret: "MY_KEY" }, operations: [{ name: "go", method: "GET", path: "/ok" }] };
    const quotaDef = { name: "cq", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "none" }, quota: { limit: 1, window_ms: 3_600_000 }, operations: [{ name: "go", method: "GET", path: "/ok" }] };
    const brkDef = { name: "cb", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "none" }, retry: { max_attempts: 1 }, operations: [{ name: "go", method: "GET", path: "/down" }] };
    const limDef = { name: "rl", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "none" }, retry: { max_attempts: 1 }, operations: [{ name: "go", method: "GET", path: "/limited" }] };

    // ---- 1. authorized list/get ----
    const created = await api(caller, { action: "create", project_id: project.id, definition: okDef });
    h.check("1a. create as owner succeeds", created.status === 200 && created.body.integration?.name === "poke", JSON.stringify(created.body));
    const listed = await api(caller, { action: "list", project_id: project.id });
    h.check("1b. list as owner returns the integration", listed.status === 200 && listed.body.integrations?.some((i) => i.name === "poke"), JSON.stringify(listed.body));
    const got = await api(caller, { action: "get", project_id: project.id, name: "poke" });
    h.check("1c. get as owner returns the full definition", got.status === 200 && got.body.integration?.operations?.length === 1, JSON.stringify(got.body));
    const vCreate = await api(caller, { action: "create", project_id: viewerProj.id, definition: { ...okDef, name: "vpoke" } });
    h.check("1d. create as viewer is refused (integration.manage)", vCreate.status === 403 && vCreate.body.code === "INSUFFICIENT_ROLE", JSON.stringify(vCreate.body));
    const vList = await api(caller, { action: "list", project_id: viewerProj.id });
    h.check("1e. list as viewer is allowed (project.read)", vList.status === 200, JSON.stringify(vList.body));
    const vGet = await api(caller, { action: "get", project_id: viewerProj.id, name: "vpoke" });
    h.check("1f. get as viewer on a non-existent integration returns 404 (not 403)", vGet.status === 404, JSON.stringify(vGet.body));

    // ---- 2. non-member rejection ----
    const outList = await api(caller, { action: "list", project_id: outProj.id });
    h.check("2a. list as a non-member is rejected with NOT_A_MEMBER", outList.status === 403 && outList.body.code === "NOT_A_MEMBER", JSON.stringify(outList.body));
    const outGet = await api(caller, { action: "get", project_id: outProj.id, name: "poke" });
    h.check("2b. get as a non-member is rejected with NOT_A_MEMBER", outGet.status === 403 && outGet.body.code === "NOT_A_MEMBER", JSON.stringify(outGet.body));
    const outTest = await api(caller, { action: "test_call", project_id: outProj.id, name: "poke", operation: "go" });
    h.check("2c. test_call as a non-member is rejected", outTest.status === 403 && outTest.body.code === "NOT_A_MEMBER", JSON.stringify(outTest.body));

    // ---- 3. cross-project rejection ----
    const crossList = await api(caller, { action: "list", project_id: otherProj.id });
    h.check("3a. listing another project does not leak this project's integration", crossList.status === 200 && !crossList.body.integrations?.some((i) => i.name === "poke"), JSON.stringify(crossList.body));
    const crossGet = await api(caller, { action: "get", project_id: otherProj.id, name: "poke" });
    h.check("3b. getting an integration by name from the wrong project returns 404", crossGet.status === 404, JSON.stringify(crossGet.body));

    // ---- 4. create validation ----
    h.check("4a. an invalid name is rejected", (await api(caller, { action: "create", project_id: project.id, definition: { ...okDef, name: "BadName" } })).status === 400);
    h.check("4b. an invalid type is rejected", (await api(caller, { action: "create", project_id: project.id, definition: { ...okDef, name: "badtype", type: "grpc" } })).status === 400);
    const credValue = await api(caller, { action: "create", project_id: project.id, definition: { name: "credval", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "bearer", secret: "MY_KEY", value: "sk_live_xxx" }, operations: [{ name: "go", method: "GET", path: "/ok" }] } });
    h.check("4c. a credential value in auth is rejected", credValue.status === 400, JSON.stringify(credValue.body));
    h.check("4d. creating a duplicate is rejected with 409", (await api(caller, { action: "create", project_id: project.id, definition: okDef })).status === 409);

    // ---- 5. update validation ----
    h.check("5a. updating a non-existent integration returns 404", (await api(caller, { action: "update", project_id: project.id, definition: { ...okDef, name: "nope" } })).status === 404);
    h.check("5b. an invalid update is rejected", (await api(caller, { action: "update", project_id: project.id, definition: { ...okDef, base_url: "not-a-url" } })).status === 400);
    const updOk = await api(caller, { action: "update", project_id: project.id, definition: { ...okDef, description: "updated desc", timeout_ms: 7000 } });
    h.check("5c. a valid update persists", updOk.status === 200 && updOk.body.integration?.description === "updated desc" && updOk.body.integration?.timeout_ms === 7000, JSON.stringify(updOk.body));

    // ---- 6. disable behavior ----
    const preTest = await api(caller, { action: "test_call", project_id: project.id, name: "poke", operation: "go" });
    h.check("6a. a test_call before disable succeeds and records an invocation", preTest.status === 200 && preTest.body.result?.ok === true && !!preTest.body.invocation_id, JSON.stringify(preTest.body));
    const disabled = await api(caller, { action: "disable", project_id: project.id, name: "poke" });
    h.check("6b. disable marks the integration disabled", disabled.status === 200 && disabled.body.integration?.status === "disabled", JSON.stringify(disabled.body));
    const testDisabled = await api(caller, { action: "test_call", project_id: project.id, name: "poke", operation: "go" });
    h.check("6c. test_call on a disabled integration is refused with INTEGRATION_DISABLED", testDisabled.status === 409 && testDisabled.body.code === "INTEGRATION_DISABLED", JSON.stringify(testDisabled.body));
    const preInvRows = await svc.entities.IntegrationInvocation.filter({ project_id: project.id, trace_id: preTest.body.trace_id }, "-created_date", 10);
    h.check("6d. disabling does not delete historical observability", preInvRows.length >= 1, JSON.stringify({ count: preInvRows.length, trace: preTest.body.trace_id }));
    // Re-enable for later tests.
    await api(caller, { action: "update", project_id: project.id, definition: okDef });

    // ---- 7. secret values never returned ----
    const secCreate = await api(caller, { action: "create", project_id: project.id, definition: secretDef });
    h.check("7a. creating an integration with a secret ref declares the secret name", secCreate.status === 200 && secCreate.body.integration?.auth?.secret === "MY_KEY", JSON.stringify(secCreate.body));
    const secRows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: "MY_KEY" }, "name", 1);
    if (secRows[0]) await svc.entities.ProjectSecret.update(secRows[0].id, { value: SECRET_VALUE });
    const secGet = await api(caller, { action: "get", project_id: project.id, name: "secret" });
    const secList = await api(caller, { action: "list", project_id: project.id });
    h.check("7b. get returns the secret NAME, never the value", secGet.body.integration?.auth?.secret === "MY_KEY" && !JSON.stringify(secGet.body).includes(SECRET_VALUE), JSON.stringify(secGet.body?.integration?.auth));
    h.check("7c. list never includes the secret value", !JSON.stringify(secList.body).includes(SECRET_VALUE), `present: ${JSON.stringify(secList.body).includes(SECRET_VALUE)}`);
    h.check("7d. secret_refs lists the name only", JSON.stringify(secGet.body.integration?.secret_refs) === JSON.stringify(["MY_KEY"]), JSON.stringify(secGet.body.integration?.secret_refs));

    // ---- 8. test_call uses the normal execution path ----
    const tc = await api(caller, { action: "test_call", project_id: project.id, name: "poke", operation: "go" });
    h.check("8a. test_call returns the upstream status and attempt count", tc.status === 200 && tc.body.result?.ok === true && tc.body.result?.status === 200 && tc.body.result?.attempts === 1, JSON.stringify(tc.body));
    h.check("8b. test_call creates an IntegrationInvocation row", !!(await svc.entities.IntegrationInvocation.filter({ project_id: project.id, integration_name: "poke" }, "-created_date", 1))[0], "no invocation");
    h.check("8c. test_call creates a FunctionInvocation row", !!(await svc.entities.FunctionInvocation.filter({ project_id: project.id, function_name: "integrationTest" }, "-created_date", 1))[0], "no function invocation");
    const spans = await svc.entities.TraceEvent.filter({ trace_id: tc.body.trace_id, project_id: project.id }, "at", 10);
    h.check("8d. test_call writes a span in the existing trace", spans.length >= 1 && spans.some((s) => s.event_type === "integration_call"), JSON.stringify(spans.map((s) => s.event_type)));
    h.check("8e. test_call on an unknown operation returns 404", (await api(caller, { action: "test_call", project_id: project.id, name: "poke", operation: "nope" })).status === 404);

    // ---- 9. test_call respects quota / breaker / rate-limit ----
    await api(caller, { action: "create", project_id: project.id, definition: quotaDef });
    const q1 = await api(caller, { action: "test_call", project_id: project.id, name: "cq", operation: "go" });
    const q2 = await api(caller, { action: "test_call", project_id: project.id, name: "cq", operation: "go" });
    h.check("9a. quota: the first call is allowed, the second is refused with QUOTA_EXCEEDED", q1.body.result?.ok === true && q2.body.result?.ok === false && q2.body.result?.code === "QUOTA_EXCEEDED", JSON.stringify({ q1: q1.body.result, q2: q2.body.result }));
    const qHitsBefore = hits[`${HOST}/v1/ok`] || 0;
    await api(caller, { action: "test_call", project_id: project.id, name: "cq", operation: "go" });
    h.check("9b. quota: a refused test_call contacts no upstream", hits[`${HOST}/v1/ok`] === qHitsBefore, `${qHitsBefore} → ${hits[`${HOST}/v1/ok`]}`);

    await api(caller, { action: "create", project_id: project.id, definition: brkDef });
    // Default breaker threshold is 5: trip it with 5 upstream failures, then the next call is refused.
    for (let i = 0; i < 5; i++) await api(caller, { action: "test_call", project_id: project.id, name: "cb", operation: "go" });
    const bHitsBefore = hits[`${HOST}/v1/down`] || 0;
    const refused = await api(caller, { action: "test_call", project_id: project.id, name: "cb", operation: "go" });
    h.check("9c. breaker: after the threshold of failures the next call is refused as circuit_open with zero attempts", refused.body.result?.ok === false && refused.body.result?.kind === "circuit_open" && refused.body.result?.attempts === 0, JSON.stringify(refused.body.result));
    h.check("9d. breaker: a refused test_call contacts no upstream", hits[`${HOST}/v1/down`] === bHitsBefore, `${bHitsBefore} → ${hits[`${HOST}/v1/down`]}`);

    await api(caller, { action: "create", project_id: project.id, definition: limDef });
    const rl = await api(caller, { action: "test_call", project_id: project.id, name: "rl", operation: "go" });
    h.check("9e. rate-limit: a 429 is surfaced as rate_limited", rl.body.result?.ok === false && rl.body.result?.kind === "rate_limited" && rl.body.result?.status === 429, JSON.stringify(rl.body.result));

    // ---- 10. project isolation ----
    await api(caller, { action: "create", project_id: otherProj.id, definition: { ...quotaDef, name: "cq" } });
    const iso = await api(caller, { action: "test_call", project_id: otherProj.id, name: "cq", operation: "go" });
    h.check("10a. one project's exhausted quota never refuses another project's call", iso.body.result?.ok === true, JSON.stringify(iso.body.result));
    const isoRows = await svc.entities.IntegrationQuota.filter({ project_id: otherProj.id, integration_name: "cq" }, "-updated_at", 1);
    h.check("10b. the other project holds its own quota row, keyed apart", isoRows[0]?.project_id === otherProj.id && isoRows[0]?.used === 1, JSON.stringify(isoRows[0]));

    // ---- 11. audit / trace preservation ----
    const audits = await svc.entities.AuditLog.filter({ project_id: project.id, workspace_id: workspace.id }, "-created_date", 100);
    const actions = audits.map((a) => a.action);
    h.check("11a. create wrote an integration.create audit entry", actions.includes("integration.create"), JSON.stringify(actions));
    h.check("11b. update wrote an integration.update audit entry", actions.includes("integration.update"), JSON.stringify(actions));
    h.check("11c. disable wrote an integration.disable audit entry", actions.includes("integration.disable"), JSON.stringify(actions));
    const tcSpans = await svc.entities.TraceEvent.filter({ trace_id: tc.body.trace_id }, "at", 50);
    h.check("11d. test_call's trace is preserved in the existing trace system", tcSpans.length >= 1 && tcSpans.every((s) => s.trace_id === tc.body.trace_id), `${tcSpans.length} spans`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    globalThis.fetch = realFetch;
    setDnsLookupForTests(null);
    for (const p of [project, otherProj, viewerProj, outProj]) {
      if (!p) continue;
      for (const entity of ["ProjectFile", "ProjectSecret", "AuditLog", "IntegrationInvocation", "IntegrationQuota", "IntegrationBreaker", "IntegrationRateLimit", "TraceEvent", "FunctionInvocation"]) {
        await purgeBy(svc, entity, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const ws of [workspace, viewerWs, outWs]) {
      if (!ws) continue;
      await purgeBy(svc, "WorkspaceMember", { workspace_id: ws.id });
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  return harnessResponse(h);
}