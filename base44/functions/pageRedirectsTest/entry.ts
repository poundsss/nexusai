// Targeted certification for the path-level Page Redirects contract.
//
// Covers: source/target normalization (trailing slash + percent-decode, `/old/` == `/%6Fld`),
// single + prefix matching, prefix remainder, external `https://` target, visitor query-string
// carryover, excluded paths (auth + system files) never match, source==target rejection, the
// 50/app limit, the custom-domains plan gate on writes (listing open), CRUD through the real
// control-plane function, and a runtime 301 delivered by the appRuntime artifact branch against
// a real LIVE deployment. The separate data/API runtime is asserted untouched (matchRedirect is
// never invoked for db/fn actions by construction; verified by reading the patch).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs } from "../../shared/projectFs.ts";
import { createVersion } from "../../shared/persistence.ts";
import { runDeploymentStep, ensureProjectSlug } from "../../shared/deploy.ts";
import {
  normalizePath, normalizeTarget, validateRule, matchRedirect, isExcludedPath, MAX_REDIRECTS_PER_APP,
} from "../../shared/pageRedirects.ts";

const MAIN = `import { html, render } from 'runtime'; render(html\`<div>ok</div>\`, document.getElementById('app'));`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let workspace = null, project = null;
  const stamp = Date.now();

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    // ===================== pure logic: normalization =====================
    check("trailing slash stripped (root preserved)", normalizePath("/old/") === "/old" && normalizePath("/") === "/", JSON.stringify(normalizePath("/old/")));
    check("percent-escapes decoded before storing", normalizePath("/%6Fld") === "/old", JSON.stringify(normalizePath("/%6Fld")));
    check("/old/ and /%6Fld normalize to the same rule", normalizePath("/old/") === normalizePath("/%6Fld"), "collision");
    check("query string rejected in source", normalizePath("/old?x=1") === null, "should reject ?");
    check("fragment rejected in source", normalizePath("/old#top") === null, "should reject #");
    check("non-/ prefix rejected", normalizePath("old") === null, "should reject bare path");

    // ===================== pure logic: target normalization =====================
    check("internal target normalized", normalizeTarget("/new/").ok && normalizeTarget("/new/").value === "/new", JSON.stringify(normalizeTarget("/new/")));
    const ext = normalizeTarget("https://example.com/help");
    check("external https target kept verbatim", ext.ok && ext.external && ext.value === "https://example.com/help", JSON.stringify(ext));
    check("external target with query rejected", !normalizeTarget("https://example.com/x?y=1").ok, "query forbidden");
    check("external target with fragment rejected", !normalizeTarget("https://example.com/x#z").ok, "fragment forbidden");
    check("http:// target rejected (https only)", !normalizeTarget("http://example.com/x").ok, "http forbidden");

    // ===================== pure logic: validateRule =====================
    const ok = validateRule({ source_path: "/old", target_path: "/new", match_type: "single" });
    check("valid rule normalizes fields", ok.source_path === "/old" && ok.target_path === "/new" && ok.match_type === "single", JSON.stringify(ok));
    await expectThrow("source==target rejected", () => validateRule({ source_path: "/x", target_path: "/x" }), "SOURCE_EQUALS_TARGET");
    await expectThrow("excluded source rejected (system file)", () => validateRule({ source_path: "/sitemap.xml", target_path: "/new" }), "EXCLUDED_SOURCE");
    await expectThrow("excluded source rejected (auth path)", () => validateRule({ source_path: "/login", target_path: "/new" }), "EXCLUDED_SOURCE");
    await expectThrow("/.well-known descendant excluded", () => validateRule({ source_path: "/.well-known/foo", target_path: "/new" }), "EXCLUDED_SOURCE");
    await expectThrow("invalid match_type rejected", () => validateRule({ source_path: "/old", target_path: "/new", match_type: "glob" }), "INVALID_MATCH_TYPE");

    // ===================== pure logic: matchRedirect =====================
    const rules = [
      { source_path: "/old", target_path: "/new", match_type: "single" },
      { source_path: "/docs", target_path: "https://example.com/help", match_type: "prefix" },
      { source_path: "/blog", target_path: "/news", match_type: "prefix" },
    ];
    const single = matchRedirect(rules, "/old", "");
    check("single match returns 301 + internal location", single?.status === 301 && single.location === "/new", JSON.stringify(single));
    const singleQs = matchRedirect(rules, "/old", "?utm=x");
    check("visitor query string carries over (internal)", singleQs?.location === "/new?utm=x", JSON.stringify(singleQs));
    const prefixExt = matchRedirect(rules, "/docs/setup", "");
    check("prefix match appends remainder to external target", prefixExt?.location === "https://example.com/help/setup", JSON.stringify(prefixExt));
    const prefixInt = matchRedirect(rules, "/blog/2024/hello", "");
    check("prefix match appends remainder to internal target", prefixInt?.location === "/news/2024/hello", JSON.stringify(prefixInt));
    const prefixQs = matchRedirect(rules, "/docs/setup", "?q=1");
    check("prefix match carries visitor query string", prefixQs?.location === "https://example.com/help/setup?q=1", JSON.stringify(prefixQs));
    check("non-matching path returns null", matchRedirect(rules, "/other", "") === null, "should be null");
    check("excluded path never matches (even with a matching rule)", matchRedirect([{ source_path: "/s", target_path: "/x", match_type: "prefix" }], "/sitemap.xml", "") === null, "sitemap must not redirect");
    check("auth path never matches", matchRedirect([{ source_path: "/login", target_path: "/x", match_type: "single" }], "/login", "") === null, "login must not redirect");
    check("50/app limit constant", MAX_REDIRECTS_PER_APP === 50, String(MAX_REDIRECTS_PER_APP));

    // ===================== end-to-end: scratch workspace + project =====================
    workspace = await svc.entities.Workspace.create({ name: `redirect-ws-${stamp}`, owner_id: caller.id, status: "active" });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Redirect App ${stamp}`, slug: `redirect-${stamp}` });

    // Listing is open WITHOUT the custom-domains plan gate (free plan has custom_domains = 0).
    const listed = await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "list" });
    check("list succeeds without plan gate (free)", listed.status === 200 && listed.data?.redirects?.length === 0, JSON.stringify(listed.data));

    // Writes require the custom-domains entitlement; a free workspace is refused (402).
    const refused = await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "create", source_path: "/old", target_path: "/new", match_type: "single" });
    check("create refused on free plan (402 PLAN_REDIRECTS_NOT_INCLUDED)", refused.status === 402 && refused.data?.code === "PLAN_REDIRECTS_NOT_INCLUDED", JSON.stringify(refused.data));

    // Promote the scratch workspace to a plan that includes custom domains, then exercise CRUD.
    const plan = await svc.entities.BillingPlan.create({ code: `redirect-pro-${stamp}`, name: "Redirect Pro", limits: { custom_domains: 5 }, entitlements: { custom_domains: 5 }, provider: "none", active: true });
    await svc.entities.Subscription.create({ workspace_id: workspace.id, plan_code: plan.code, status: "active", current_period_start: new Date().toISOString() });

    const created = await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "create", source_path: "/old-pricing", target_path: "/pricing", match_type: "single" });
    check("create succeeds on paid plan", created.status === 201 && created.data?.redirect?.source_path === "/old-pricing", JSON.stringify(created.data));
    const rid = created.data?.redirect?.id;

    const updated = await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "update", redirect_id: rid, source_path: "/old-pricing", target_path: "/plans", match_type: "prefix" });
    check("update changes target + match_type", updated.status === 200 && updated.data?.redirect?.target_path === "/plans" && updated.data?.redirect?.match_type === "prefix", JSON.stringify(updated.data));

    const afterUpdate = await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "list" });
    check("list reflects the update", afterUpdate.data?.redirects?.length === 1 && afterUpdate.data.redirects[0].target_path === "/plans", JSON.stringify(afterUpdate.data));

    // Cross-project isolation: a redirect id from another project is "not found".
    const otherProj = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Other ${stamp}`, slug: `other-${stamp}` });
    const foreign = await base44.functions.invoke("pageRedirects", { project_id: otherProj.id, action: "update", redirect_id: rid, source_path: "/x", target_path: "/y", match_type: "single" });
    check("redirect id from another project is not found", foreign.status === 404, JSON.stringify(foreign.data));

    // 50/app limit: fill to 50, the 51st is refused. (Clean the first row first so we count from 0.)
    await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "delete", redirect_id: rid });
    for (let i = 0; i < MAX_REDIRECTS_PER_APP; i++) {
      await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "create", source_path: `/r${i}`, target_path: "/dest", match_type: "single" });
    }
    const over = await base44.functions.invoke("pageRedirects", { project_id: project.id, action: "create", source_path: "/overflow", target_path: "/dest", match_type: "single" });
    check("51st redirect refused (REDIRECT_LIMIT)", over.status === 400 && over.data?.code === "REDIRECT_LIMIT", JSON.stringify(over.data));

    // ===================== runtime 301 via the real artifact branch =====================
    // Drive a real production deployment so resolveLive succeeds, then ask the artifact branch
    // for a path that matches one of the scratch rules — it must return a 301 directive instead
    // of the bundle. A non-matching path returns the bundle (no redirect key).
    const fs = createFs([]);
    fs.files.set("index.html", { id: null, path: "index.html", content: MAIN, original: null });
    const version = await createVersion(svc, { project, fs, message: "v1", author: "test" });
    await ensureProjectSlug(svc, project);
    const d = await svc.entities.Deployment.create({
      project_id: project.id, workspace_id: workspace.id, version_id: version.id, version_number: version.number,
      environment: "production", status: "QUEUED", trigger: "user", deployment_url: `/`, deployed_by: "test",
      cancel_requested: false, recovery_count: 0, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    });
    for (let i = 0; i < 10; i++) { const out = await runDeploymentStep(svc, d.id); if (out.done) break; }

    // Ensure a rule exists that targets /dest from /r0 (single).
    const rt = await base44.functions.invoke("appRuntime", { host: project.slug, action: "artifact", path: "/r0", search: "?utm=z" });
    check("artifact branch returns 301 directive for a matching page path", rt.status === 200 && rt.data?.redirect?.status === 301 && rt.data?.redirect?.location === "/dest?utm=z", JSON.stringify(rt.data?.redirect));

    const nope = await base44.functions.invoke("appRuntime", { host: project.slug, action: "artifact", path: "/does-not-exist" });
    check("non-matching page path serves the bundle (no redirect)", nope.status === 200 && !nope.data?.redirect && !!nope.data?.files, "should serve artifact");

    // The data/API runtime is untouched: a db action does not carry a path and never sees
    // matchRedirect. We assert the artifact-branch redirect key is absent from a db response
    // shape by confirming the db action rejects (no live data wiring) rather than redirecting.
    const db = await base44.functions.invoke("appRuntime", { host: project.slug, action: "db", op: "list", args: { entity: "Nope" } });
    check("data/API runtime never returns a redirect directive", !db.data?.redirect, "db path must not redirect");

    await cleanupWorkspace(svc, workspace.id, ["PageRedirect", "Project", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Subscription", "BillingPlan"]);
    return harnessResponse(harness);
  } catch (error) {
    if (workspace) await cleanupWorkspace(svc, workspace.id, ["PageRedirect", "Project", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Subscription", "BillingPlan"]);
    return harnessError(harness, error);
  }
}