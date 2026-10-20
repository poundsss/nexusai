// Targeted certification for the Platform Badge gap (the documented Base44 project-level
// "Made with Base44" attribution toggle): default state, get/set persistence, the Starter+
// plan gate, private-project auto-hide, downgrade re-show, and the published-runtime
// `app.badge.visible` contract that PublicApp consumes to render/hide the badge overlay.
//
// Runs against disposable scratch data only — a scratch workspace owned by the caller, a
// scratch project, a scratch Starter BillingPlan + Subscription, and a scratch LIVE
// deployment. No real production project is touched; no implementation is modified unless a
// check fails and proves an actual defect.
//
// The SDK's functions.invoke throws on non-2xx (the functions axios client has response
// interception disabled), so a `tryInvoke` helper normalizes both thrown and returned
// responses into { status, data } — the same shape the refusal assertions expect.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { packJson } from "../../shared/blobStore.ts";
import { badgeVisible } from "../../shared/platformBadge.ts";
import { badgeRemovalEntitled } from "../../shared/planLimits.ts";

// Normalize a function invoke into { status, data } whether it resolved (2xx AxiosResponse) or
// rejected (non-2xx throws, since the functions client disables response interception).
async function tryInvoke(client, name, payload) {
  try {
    const r = await client.functions.invoke(name, payload);
    return { status: r.status, data: r.data };
  } catch (e) {
    return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? { error: e.message, code: e.code ?? null } };
  }
}

// Workspace-scoped cleanup (entities that carry workspace_id).
const CLEANUP = ["Project", "Deployment", "Subscription", "AuditLog"];
// Project-scoped cleanup (entities that carry project_id but NOT workspace_id) — purged by id
// explicitly so the scratch deployment leaves no artifact/version residue.
const PROJECT_SCOPED = ["DeploymentArtifact", "ProjectVersion"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check } = harness;
  let workspace = null, project = null;
  const createdPlans = [];
  const stamp = Date.now();

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    // ===================== pure badgeVisible contract =====================
    check("badgeVisible: null project → false", badgeVisible(null, false) === false);
    check("badgeVisible: private + badge_hidden false + entitled → false (private auto-hide)", badgeVisible({ visibility: "private", badge_hidden: false }, true) === false);
    check("badgeVisible: private + badge_hidden true + entitled → false", badgeVisible({ visibility: "private", badge_hidden: true }, true) === false);
    check("badgeVisible: public + badge_hidden false + not entitled → true (default shown)", badgeVisible({ visibility: "public", badge_hidden: false }, false) === true);
    check("badgeVisible: public + badge_hidden true + NOT entitled → true (downgrade re-shows)", badgeVisible({ visibility: "public", badge_hidden: true }, false) === true);
    check("badgeVisible: public + badge_hidden true + entitled → false (hidden)", badgeVisible({ visibility: "public", badge_hidden: true }, true) === false);
    check("badgeVisible: workspace visibility + badge_hidden false → true", badgeVisible({ visibility: "workspace", badge_hidden: false }, false) === true);

    // ===================== scratch workspace + project (caller is owner) =====================
    workspace = await svc.entities.Workspace.create({ name: `badge-ws-${stamp}`, owner_id: caller.id, status: "active" });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Badge App ${stamp}`, slug: `badge-${stamp}` });

    // ----- existing projects without the field remain unchanged: default badge_hidden=false -----
    const rawRow = await svc.entities.Project.get(project.id);
    check("existing project: badge_hidden is falsy by default (field absent/unset)", !rawRow.badge_hidden, String(rawRow.badge_hidden));

    const get0 = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "get" });
    check("get on default project: badge_hidden=false, effective_hidden=false, visibility=public", get0.status === 200 && get0.data?.badge_hidden === false && get0.data?.effective_hidden === false && get0.data?.visibility === "public", JSON.stringify(get0.data));
    check("get on default project: entitled=false for a subscription-less (free) workspace", get0.data?.entitled === false, JSON.stringify(get0.data));

    // ----- Free plan cannot hide the badge → 402 -----
    const hideFree = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "set", badge_hidden: true });
    check("free plan set badge_hidden=true refused with 402 PLAN_BADGE_REMOVAL_NOT_INCLUDED", hideFree.status === 402 && hideFree.data?.code === "PLAN_BADGE_REMOVAL_NOT_INCLUDED", JSON.stringify(hideFree.data));
    const afterRefuse = await svc.entities.Project.get(project.id);
    check("free plan refusal did NOT persist badge_hidden (row unchanged)", !afterRefuse.badge_hidden, String(afterRefuse.badge_hidden));

    // Turning the badge ON (badge_hidden=false) is always allowed, even on free.
    const showFree = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "set", badge_hidden: false });
    check("free plan set badge_hidden=false succeeds (turning ON always allowed)", showFree.status === 200 && showFree.data?.badge_hidden === false && showFree.data?.effective_hidden === false, JSON.stringify(showFree.data));

    // ----- Starter+ active subscription can hide it -----
    const starterPlan = await svc.entities.BillingPlan.create({
      code: `test_starter_${stamp}`, name: "Test Starter", price_cents: 1900, interval: "monthly", tier_rank: 3, visibility: "hidden", active: true,
      included_credits: 100000, overage_policy: "allow_overage", limits: {}, usage_limits: {}, model_access: [], entitlements: {}, provider: "none",
    });
    createdPlans.push(starterPlan.id);
    await svc.entities.Subscription.create({ workspace_id: workspace.id, plan_code: starterPlan.code, status: "active", provider: "none", current_period_start: new Date(stamp - 60000).toISOString(), entitlements: {} });

    const entitledNow = await badgeRemovalEntitled(svc, workspace);
    check("Starter (tier_rank 3) active subscription → badgeRemovalEntitled true", entitledNow === true, String(entitledNow));

    const hideStarter = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "set", badge_hidden: true });
    check("Starter set badge_hidden=true succeeds (200) and reports effective_hidden=true", hideStarter.status === 200 && hideStarter.data?.badge_hidden === true && hideStarter.data?.effective_hidden === true, JSON.stringify(hideStarter.data));

    const persisted = await svc.entities.Project.get(project.id);
    check("badge_hidden=true persists on the Project row", persisted.badge_hidden === true, String(persisted.badge_hidden));

    const getHidden = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "get" });
    check("get after hide: badge_hidden=true, entitled=true, effective_hidden=true", getHidden.status === 200 && getHidden.data?.badge_hidden === true && getHidden.data?.entitled === true && getHidden.data?.effective_hidden === true, JSON.stringify(getHidden.data));

    // Turning back ON on an entitled workspace also succeeds.
    const showStarter = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "set", badge_hidden: false });
    check("Starter set badge_hidden=false succeeds and effective_hidden=false", showStarter.status === 200 && showStarter.data?.badge_hidden === false && showStarter.data?.effective_hidden === false, JSON.stringify(showStarter.data));
    const afterShow = await svc.entities.Project.get(project.id);
    check("badge_hidden=false persists after re-show", !afterShow.badge_hidden, String(afterShow.badge_hidden));

    // ----- private projects always resolve to hidden (independent of the setting) -----
    await svc.entities.Project.update(project.id, { visibility: "private", badge_hidden: false });
    const getPriv = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "get" });
    check("private + badge_hidden=false: effective_hidden=true (private auto-hide)", getPriv.status === 200 && getPriv.data?.badge_hidden === false && getPriv.data?.effective_hidden === true && getPriv.data?.visibility === "private", JSON.stringify(getPriv.data));

    await svc.entities.Project.update(project.id, { badge_hidden: true });
    const getPrivHidden = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "get" });
    check("private + badge_hidden=true: effective_hidden=true (still hidden)", getPrivHidden.data?.effective_hidden === true, JSON.stringify(getPrivHidden.data));

    // back to public + hidden for the downgrade test
    await svc.entities.Project.update(project.id, { visibility: "public" });

    // ----- downgraded / non-entitled projects resolve to visible -----
    const subs = await svc.entities.Subscription.filter({ workspace_id: workspace.id }, "-created_date", 5);
    for (const s of subs) await svc.entities.Subscription.update(s.id, { status: "expired" });
    const entitledAfterLapse = await badgeRemovalEntitled(svc, workspace);
    check("lapsed subscription → badgeRemovalEntitled false (downgrade)", entitledAfterLapse === false, String(entitledAfterLapse));
    const getLapsed = await tryInvoke(base44, "projectBadge", { project_id: project.id, action: "get" });
    check("downgraded: badge_hidden still true on row but effective_hidden=false (re-shown) and entitled=false", getLapsed.data?.badge_hidden === true && getLapsed.data?.effective_hidden === false && getLapsed.data?.entitled === false, JSON.stringify(getLapsed.data));

    // ===================== published-runtime app.badge.visible contract =====================
    // Publish a LIVE deployment directly (artifact + LIVE Deployment + project pointer), bypassing
    // the build engine — the badge contract only needs resolveLive to find a serving deployment and
    // read project.badge_hidden + visibility into `app.badge.visible`. No runBuild, no project files.
    for (const s of subs) await svc.entities.Subscription.update(s.id, { status: "active" });
    await svc.entities.Project.update(project.id, { badge_hidden: false, visibility: "public" });

    const version = await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "badge cert" });
    const payloadUrl = await packJson(svc, `badge-artifact-${stamp}.json`, {
      client_files: [{ path: "index.html", content: "<!doctype html><html><body><div id=root></div></body></html>" }],
      functions: [], entities: [], connectors: [], config: { entry: "index.html", framework: "preact-htm" },
    });
    const checksum = `sha256:badge-${stamp}`;
    const artifactRow = await svc.entities.DeploymentArtifact.create({
      project_id: project.id, version_id: version.id, version_number: version.number,
      checksum, payload_url: payloadUrl, file_count: 1, client_file_count: 1,
      secret_scan: "pass", size_bytes: 128, built_by: "test",
    });
    const deployment = await svc.entities.Deployment.create({
      project_id: project.id, workspace_id: workspace.id, version_id: version.id, version_number: version.number,
      environment: "production", status: "LIVE", trigger: "user", artifact_id: artifactRow.id, artifact_checksum: checksum,
      deployed_by: "test", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    });
    await svc.entities.Project.update(project.id, { production_deployment_id: deployment.id, production_version_number: version.number, status: "ready" });

    // Scenario A: public + badge_hidden=false + entitled (active Starter) → visible=true (default shown)
    await svc.entities.Project.update(project.id, { badge_hidden: false, visibility: "public" });
    const artA = await tryInvoke(base44, "appRuntime", { slug: project.slug, action: "artifact" });
    check("artifact A (public+shown+entitled): badge.visible=true", artA.status === 200 && artA.data?.app?.badge?.visible === true, JSON.stringify(artA.data?.app?.badge));
    check("artifact A: badge.visible matches badgeVisible(project, entitled=false since badge_hidden=false)", artA.data?.app?.badge?.visible === badgeVisible({ visibility: "public", badge_hidden: false }, false), String(artA.data?.app?.badge?.visible));

    // Scenario B: public + badge_hidden=true + entitled → visible=false (hidden)
    await svc.entities.Project.update(project.id, { badge_hidden: true });
    const artB = await tryInvoke(base44, "appRuntime", { slug: project.slug, action: "artifact" });
    check("artifact B (public+hidden+entitled): badge.visible=false", artB.status === 200 && artB.data?.app?.badge?.visible === false, JSON.stringify(artB.data?.app?.badge));
    check("artifact B: badge.visible matches badgeVisible(project, entitled=true)", artB.data?.app?.badge?.visible === badgeVisible({ visibility: "public", badge_hidden: true }, true), String(artB.data?.app?.badge?.visible));

    // Scenario C: public + badge_hidden=true + lapsed (downgrade) → visible=true (re-shown)
    for (const s of subs) await svc.entities.Subscription.update(s.id, { status: "expired" });
    const artC = await tryInvoke(base44, "appRuntime", { slug: project.slug, action: "artifact" });
    check("artifact C (public+hidden+lapsed): badge.visible=true (downgrade re-shows)", artC.status === 200 && artC.data?.app?.badge?.visible === true, JSON.stringify(artC.data?.app?.badge));
    check("artifact C: badge.visible matches badgeVisible(project, entitled=false after lapse)", artC.data?.app?.badge?.visible === badgeVisible({ visibility: "public", badge_hidden: true }, false), String(artC.data?.app?.badge?.visible));

    // Scenario D: private + badge_hidden=false → the artifact is auth-gated (401 AUTH_REQUIRED) for
    // an anonymous visitor, and badgeVisible(private,...) === false — so a private app NEVER shows
    // the badge: it is gated behind sign-in, and once opened the flag the runtime would serve is
    // false. This pair is the published-runtime contract for private apps.
    for (const s of subs) await svc.entities.Subscription.update(s.id, { status: "active" });
    await svc.entities.Project.update(project.id, { badge_hidden: false, visibility: "private" });
    const artD = await tryInvoke(base44, "appRuntime", { slug: project.slug, action: "artifact" });
    check("artifact D (private): anonymous artifact refused 401 'Sign in required' (private gating unchanged)", artD.status === 401 && /sign in required/i.test(String(artD.data?.error || "")), JSON.stringify(artD.data));
    check("artifact D: badgeVisible(private, ...) === false — badge would be hidden to any authenticated visitor too", badgeVisible({ visibility: "private", badge_hidden: false }, true) === false && badgeVisible({ visibility: "private", badge_hidden: false }, false) === false);

    // PublicApp render/hide contract: the artifact `app.badge.visible` boolean is the SOLE driver of
    // PublicApp's `{state.data?.badge?.visible && <PlatformBadge />}` gate, so a correct boolean in
    // every public scenario guarantees correct render (B hides, A/C show). Confirmed boolean-typed.
    check("PublicApp render/hide contract: artifact carries a boolean badge.visible in every public scenario (A/B/C)", [artA, artB, artC].every((r) => typeof r.data?.app?.badge?.visible === "boolean"), "all boolean");

    // ----- existing projects without the field remain unchanged (re-confirm at the end) -----
    const fresh = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Fresh ${stamp}`, slug: `badge-fresh-${stamp}` });
    const freshRow = await svc.entities.Project.get(fresh.id);
    check("fresh project row has no badge_hidden set (default preserved)", !freshRow.badge_hidden, String(freshRow.badge_hidden));
    const freshGet = await tryInvoke(base44, "projectBadge", { project_id: fresh.id, action: "get" });
    check("fresh project get: badge_hidden=false and effective_hidden=false (unchanged default)", freshGet.status === 200 && freshGet.data?.badge_hidden === false && freshGet.data?.effective_hidden === false, JSON.stringify(freshGet.data));
    await svc.entities.Project.delete(fresh.id).catch(() => {});

    // ===================== cleanup =====================
    if (project) for (const name of PROJECT_SCOPED) await purgeBy(svc, name, { project_id: project.id });
    await cleanupWorkspace(svc, workspace.id, CLEANUP);
    for (const id of createdPlans) await svc.entities.BillingPlan.delete(id).catch(() => {});
    return harnessResponse(harness);
  } catch (error) {
    if (project) for (const name of PROJECT_SCOPED) await purgeBy(svc, name, { project_id: project.id }).catch(() => {});
    if (workspace) await cleanupWorkspace(svc, workspace.id, CLEANUP);
    for (const id of createdPlans) await svc.entities.BillingPlan.delete(id).catch(() => {});
    return harnessError(harness, error);
  }
}