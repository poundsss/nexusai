// Focused certification for #31F — Builder Integration Pane.
//
// The Builder pane is a thin client over the authorized Integration API (#31E): list/create/
// update/disable/test_call all go through it. The endpoint's exact path is executed INLINE
// through the shared integrationApiHelpers module. What this suite adds over #31E is the
// BUILDER-specific surface: the three integration types (HTTP, OpenAPI, MCP) through the API,
// the disable → enable (via update) → test lifecycle the pane exposes, and the empty/error
// states the pane renders. Only the network boundary of test_call's upstream is scripted.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy } from "../../shared/testHarness.ts";
import { svcOf, mockJson, makeInlineIntegrationApi } from "../../shared/integrationApiHelpers.ts";
import { setDnsLookupForTests } from "../../shared/externalTools.ts";

const HOST = "api.example.com";
const SECRET_VALUE = "sk_live_builder_must_never_leak_31f_4c2e";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = svcOf(base44);
  const h = createHarness();
  const realFetch = globalThis.fetch;
  let workspace = null, outWs = null, project = null, emptyProj = null, outProj = null;

  // DNS is scripted alongside fetch (same network-boundary rule as the other suites).
  setDnsLookupForTests((host) => {
    if (host !== HOST) throw new Error(`unscripted host ${host}`);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== HOST) return realFetch(url, options);
    if (u.pathname === "/v1/ok") return mockJson({ state: "ok" });
    return mockJson({ error: "unexpected" }, 500);
  };

  const api = makeInlineIntegrationApi(base44, svc);

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `Bld ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    outWs = await svc.entities.Workspace.create({ name: `Bld Out ${Date.now()}`, owner_id: `other_${Date.now()}`, credits_balance: 0 });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Bld ${Date.now()}`, slug: `bld-${Date.now()}` });
    emptyProj = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Bld Empty ${Date.now()}`, slug: `bld-empty-${Date.now()}` });
    outProj = await svc.entities.Project.create({ workspace_id: outWs.id, name: `Bld Out ${Date.now()}`, slug: `bld-out-${Date.now()}` });

    const httpDef = { name: "poke", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "none" }, operations: [{ name: "go", method: "GET", path: "/ok" }] };
    const openApiDef = { name: "geo", type: "openapi", base_url: `https://${HOST}/v1`, auth: { type: "none" }, operations: [{ name: "go", method: "GET", path: "/ok" }], source: { spec_version: "3.0" } };
    const mcpDef = { name: "tools", type: "mcp", server_url: `https://${HOST}/v1`, auth: { type: "none" }, operations: [{ name: "search", tool: "search", input_schema: { type: "object" } }] };
    const secretDef = { name: "secret", type: "http", base_url: `https://${HOST}/v1`, auth: { type: "bearer", secret: "MY_KEY" }, operations: [{ name: "go", method: "GET", path: "/ok" }] };

    // ---- 1. HTTP lifecycle (the pane's create → test → disable → enable → test path) ----
    const created = await api(caller, { action: "create", project_id: project.id, definition: httpDef });
    h.check("1a. create http succeeds", created.status === 200 && created.body.integration?.type === "http", JSON.stringify(created.body));
    const listed = await api(caller, { action: "list", project_id: project.id });
    h.check("1b. list returns the integration", listed.status === 200 && listed.body.integrations?.some((i) => i.name === "poke"), JSON.stringify(listed.body));
    const got = await api(caller, { action: "get", project_id: project.id, name: "poke" });
    h.check("1c. get returns the full definition with operation count", got.status === 200 && got.body.integration?.operation_count === 1, JSON.stringify(got.body));
    const tc = await api(caller, { action: "test_call", project_id: project.id, name: "poke", operation: "go" });
    h.check("1d. test_call succeeds with upstream status", tc.status === 200 && tc.body.result?.ok === true && tc.body.result?.status === 200, JSON.stringify(tc.body));
    const disabled = await api(caller, { action: "disable", project_id: project.id, name: "poke" });
    h.check("1e. disable marks the integration disabled", disabled.status === 200 && disabled.body.integration?.status === "disabled", JSON.stringify(disabled.body));
    const testDisabled = await api(caller, { action: "test_call", project_id: project.id, name: "poke", operation: "go" });
    h.check("1f. test_call on a disabled integration is refused with INTEGRATION_DISABLED", testDisabled.status === 409 && testDisabled.body.code === "INTEGRATION_DISABLED", JSON.stringify(testDisabled.body));
    const enabled = await api(caller, { action: "update", project_id: project.id, definition: { ...httpDef, status: "active" } });
    h.check("1g. enable via update restores active status", enabled.status === 200 && enabled.body.integration?.status === "active", JSON.stringify(enabled.body));
    const tc2 = await api(caller, { action: "test_call", project_id: project.id, name: "poke", operation: "go" });
    h.check("1h. test_call succeeds again after enable", tc2.status === 200 && tc2.body.result?.ok === true, JSON.stringify(tc2.body));
    const upd = await api(caller, { action: "update", project_id: project.id, definition: { ...httpDef, description: "changed", timeout_ms: 7000 } });
    h.check("1i. update persists changes", upd.status === 200 && upd.body.integration?.description === "changed" && upd.body.integration?.timeout_ms === 7000, JSON.stringify(upd.body));

    // ---- 2. OpenAPI integration through the API ----
    const oa = await api(caller, { action: "create", project_id: project.id, definition: openApiDef });
    h.check("2a. create openapi succeeds", oa.status === 200 && oa.body.integration?.type === "openapi", JSON.stringify(oa.body));
    const oaGet = await api(caller, { action: "get", project_id: project.id, name: "geo" });
    h.check("2b. get openapi returns the operation", oaGet.status === 200 && oaGet.body.integration?.operations?.[0]?.name === "go", JSON.stringify(oaGet.body));
    const oaTest = await api(caller, { action: "test_call", project_id: project.id, name: "geo", operation: "go" });
    h.check("2c. test_call on an openapi integration succeeds", oaTest.status === 200 && oaTest.body.result?.ok === true, JSON.stringify(oaTest.body));

    // ---- 3. MCP integration through the API (create/get/list; execution is #31A's scope) ----
    const mcp = await api(caller, { action: "create", project_id: project.id, definition: mcpDef });
    h.check("3a. create mcp succeeds with server_url", mcp.status === 200 && mcp.body.integration?.type === "mcp" && !!mcp.body.integration?.server_url, JSON.stringify(mcp.body));
    const mcpGet = await api(caller, { action: "get", project_id: project.id, name: "tools" });
    h.check("3b. get mcp returns the tool operation", mcpGet.status === 200 && mcpGet.body.integration?.operations?.[0]?.tool === "search", JSON.stringify(mcpGet.body));
    const mcpList = await api(caller, { action: "list", project_id: project.id });
    h.check("3c. list includes all three integration types", mcpList.body.integrations?.length === 3 && ["poke", "geo", "tools"].every((n) => mcpList.body.integrations.some((i) => i.name === n)), JSON.stringify(mcpList.body.integrations?.map((i) => i.name)));

    // ---- 4. secret values never rendered ----
    const sec = await api(caller, { action: "create", project_id: project.id, definition: secretDef });
    h.check("4a. create with a secret ref declares the name", sec.status === 200 && sec.body.integration?.auth?.secret === "MY_KEY", JSON.stringify(sec.body));
    const secRows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: "MY_KEY" }, "name", 1);
    if (secRows[0]) await svc.entities.ProjectSecret.update(secRows[0].id, { value: SECRET_VALUE });
    const secGet = await api(caller, { action: "get", project_id: project.id, name: "secret" });
    const secList = await api(caller, { action: "list", project_id: project.id });
    h.check("4b. get never returns the secret value", secGet.body.integration?.auth?.secret === "MY_KEY" && !JSON.stringify(secGet.body).includes(SECRET_VALUE), JSON.stringify(secGet.body?.integration?.auth));
    h.check("4c. list never returns the secret value", !JSON.stringify(secList.body).includes(SECRET_VALUE), `present: ${JSON.stringify(secList.body).includes(SECRET_VALUE)}`);

    // ---- 5. project isolation ----
    const crossGet = await api(caller, { action: "get", project_id: emptyProj.id, name: "poke" });
    h.check("5a. getting an integration from the wrong project returns 404", crossGet.status === 404, JSON.stringify(crossGet.body));
    const crossList = await api(caller, { action: "list", project_id: emptyProj.id });
    h.check("5b. listing another project does not leak this project's integrations", crossList.status === 200 && !crossList.body.integrations?.some((i) => i.name === "poke"), JSON.stringify(crossList.body));

    // ---- 6. empty state ----
    const emptyList = await api(caller, { action: "list", project_id: emptyProj.id });
    h.check("6a. a project with no integrations lists an empty array (empty state)", emptyList.status === 200 && Array.isArray(emptyList.body.integrations) && emptyList.body.integrations.length === 0, JSON.stringify(emptyList.body));

    // ---- 7. error / unauthorized state ----
    const outList = await api(caller, { action: "list", project_id: outProj.id });
    h.check("7a. a non-member list is rejected with NOT_A_MEMBER (error state)", outList.status === 403 && outList.body.code === "NOT_A_MEMBER", JSON.stringify(outList.body));
    const badCreate = await api(caller, { action: "create", project_id: project.id, definition: { ...httpDef, name: "Bad Name" } });
    h.check("7b. an invalid definition returns a 400 error state", badCreate.status === 400, JSON.stringify(badCreate.body));
    const missingGet = await api(caller, { action: "get", project_id: project.id, name: "nope" });
    h.check("7c. a missing integration returns 404 (error state)", missingGet.status === 404, JSON.stringify(missingGet.body));
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    globalThis.fetch = realFetch;
    setDnsLookupForTests(null);
    for (const p of [project, emptyProj, outProj]) {
      if (!p) continue;
      for (const entity of ["ProjectFile", "ProjectSecret", "AuditLog", "IntegrationInvocation", "IntegrationQuota", "IntegrationBreaker", "IntegrationRateLimit", "TraceEvent", "FunctionInvocation"]) {
        await purgeBy(svc, entity, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const ws of [workspace, outWs]) {
      if (!ws) continue;
      await purgeBy(svc, "WorkspaceMember", { workspace_id: ws.id });
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  return harnessResponse(h);
}