// P-10.3 phase 1 regression suite — native mobile build infrastructure.
//
// Certifies the queue, the worker lifecycle and artifact pinning WITHOUT touching the web
// deployment pipeline: an authorized workspace can request a build pinned to the deployment's
// immutable artifact; a concurrent request does not duplicate it; the worker reclaims a dead
// worker's lease with bounded recovery; a failed build releases its lease and writes its audit
// event; terminal states are never overwritten; the plan's mobile_builds_per_day ceiling is
// fail-closed and workspace-isolated; the worker boundary requires auth; and a client cannot
// read build rows directly (RLS). No real App Store / Play signing — Phase 1 only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestMobileBuild, runMobileBuildStep, MAX_MOBILE_BUILD_RECOVERIES } from "../../shared/mobileBuilds.ts";
import { createMobileBuildHarness } from "../../shared/mobileBuildTestFixtures.ts";
import { packJson } from "../../shared/blobStore.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const BAD_PAYLOAD_URL = "https://invalid.invalid/mobile-phase1-nope.json";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let wsA = null, wsB = null, wsQ = null, planRow = null;
  const track = { projects: [], versions: [], deployments: [], artifacts: [], builds: [] };

  // The scratch fixtures (workspaces, projects, versions, deployment+artifact pairs, the
  // worker driver) come from the shared mobile build harness (see createMobileBuildHarness).

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const { drive, getBuild, mkWs, mkProject, mkFixture, provisionSigning } = createMobileBuildHarness({ base44, svc, caller, track });
    wsA = await mkWs("mb-a"); wsB = await mkWs("mb-b"); wsQ = await mkWs("mb-quota");
    // P-10.3 phase 2: the SIGNING phase resolves the workspace's signing credentials and fails
    // closed without one, so every workspace whose builds this suite drives to READY is
    // provisioned here (the missing-credential refusal is certified by mobileBuildArtifactTest).
    await provisionSigning(wsA, ["ios", "android"]);
    await provisionSigning(wsQ, ["ios"]);

    // A real, loadable artifact payload for the packaging step to read.
    const payloadUrl = await packJson(svc, `mobile-p1-artifact-${Date.now()}.json`, {
      client_files: [{ path: "index.html", content: "<html><body>ok</body></html>" }],
      functions: [], config: { entry: "index.html", framework: "preact-htm" },
    });
    const checksumA = "sha256:mobile-p1-a";

    // ------------------------------------------------ authorized workspace: request + pinning
    const { project: pA, version: vA } = await mkProject(wsA, "mb-a-app");
    const fixA = await mkFixture(wsA, pA, vA, payloadUrl, checksumA, 1);
    const filesBefore = await svc.entities.ProjectFile.filter({ project_id: pA.id }, "created_date", 200);

    const req1 = await requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "ios" });
    const b1 = await getBuild(req1.build.id);
    check("an authorized workspace can request a mobile build", b1.status === "QUEUED" && b1.platform === "ios", b1.status);
    check("the build is pinned to the deployment's immutable artifact",
      b1.artifact_id === fixA.artifact.id && b1.checksum === fixA.artifact.checksum && b1.deployment_id === fixA.deployment.id,
      "pinned");
    check("the requesting user is recorded", b1.created_by === caller.id, "created_by");
    check("the request wrote its audit event",
      (await svc.entities.AuditLog.filter({ workspace_id: wsA.id, action: "mobile_build.requested" }, "-created_date", 20))
        .some((a) => a.resource_id === b1.id),
      "audited");

    // ------------------------------------------------ no duplicates: concurrent + replayed requests
    await expectThrow("a concurrent request for the same platform is refused",
      () => requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "ios" }), "MOBILE_BUILD_IN_PROGRESS");
    check("a refused request creates no second build row",
      (await svc.entities.MobileBuild.filter({ project_id: pA.id }, "-created_date", 50)).length === 1, "still 1");

    // ------------------------------------------------ RLS: a client cannot read build rows directly
    const rls = await base44.entities.MobileBuild.list().then((rows) => ({ rows })).catch(() => ({ rows: null }));
    check("a client cannot directly read mobile builds", rls.rows === null || rls.rows.length === 0, `${rls.rows === null ? "denied" : rls.rows.length}`);

    // ------------------------------------------------ worker lifecycle: phases, terminal, immutability
    const out1 = await drive(b1.id);
    check("the worker drives the build to READY", out1.done && out1.status === "READY", out1.status);
    const b1done = out1.build;
    check("the READY build produced a checksummed package with no cryptographic signature",
      !!b1done.artifact_uri && /^[0-9a-f]{64}$/.test(b1done.package_checksum || "") && !b1done.signed_at && b1done.checksum === checksumA,
      b1done.package_checksum);
    check("a completed build writes its audit event",
      (await svc.entities.AuditLog.filter({ workspace_id: wsA.id, action: "mobile_build.completed" }, "-created_date", 20))
        .some((a) => a.resource_id === b1.id),
      "audited");
    const reRun = await runMobileBuildStep(svc, b1.id);
    const reRunRows = await svc.entities.MobileBuild.filter({ project_id: pA.id }, "-created_date", 50);
    check("a terminal build is never overwritten by a retry", reRun.done && reRun.status === "READY" && reRunRows.length === 1, `${reRun.status}`);
    check("the immutable artifact is untouched by the build",
      (await svc.entities.DeploymentArtifact.get(fixA.artifact.id)).checksum === checksumA,
      "artifact unchanged");
    const filesAfter = await svc.entities.ProjectFile.filter({ project_id: pA.id }, "created_date", 200);
    check("the build never read or touched mutable working files", filesBefore.length === filesAfter.length, `${filesBefore.length}/${filesAfter.length}`);

    // ------------------------------------------------ cross-project + validation guards
    const { project: pB } = await mkProject(wsB, "mb-b-app");
    await expectThrow("a deployment id from another project is refused",
      () => requestMobileBuild(base44, caller, { project_id: pB.id, deployment_id: fixA.deployment.id, platform: "ios" }), "DEPLOYMENT_NOT_FOUND");
    await expectThrow("an invalid platform is refused",
      () => requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "windows" }), "INVALID_PLATFORM");
    const noArtifact = await svc.entities.Deployment.create({
      project_id: pA.id, workspace_id: wsA.id, version_id: vA.id, version_number: 1,
      status: "QUEUED", environment: "production", trigger: "user",
    });
    track.deployments.push(noArtifact.id);
    await expectThrow("a deployment with no built artifact cannot be packaged",
      () => requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: noArtifact.id, platform: "ios" }), "NO_ARTIFACT");

    // ------------------------------------------------ failed build: terminal + lease released + audited
    const fixBad = await mkFixture(wsA, pA, vA, BAD_PAYLOAD_URL, "sha256:mobile-p1-bad", 2);
    const reqBad = await requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixBad.deployment.id, platform: "android" });
    const bBad = await getBuild(reqBad.build.id);
    const outBad = await drive(bBad.id);
    const bBadDone = outBad.build;
    check("an unloadable pinned artifact fails the build terminally",
      outBad.done && outBad.status === "FAILED" && bBadDone.failure_code === "ARTIFACT_ERROR", bBadDone.failure_code);
    check("a failed build releases its lease",
      bBadDone.lease_token == null && bBadDone.lease_expires_at == null && !!bBadDone.completed_at, "released");
    check("a failed build writes its audit event",
      (await svc.entities.AuditLog.filter({ workspace_id: wsA.id, action: "mobile_build.failed" }, "-created_date", 20))
        .some((a) => a.resource_id === bBad.id),
      "audited");

    // ------------------------------------------------ bounded recovery of a dead worker
    const req3 = await requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "android" });
    const b3 = await getBuild(req3.build.id);
    await svc.entities.MobileBuild.update(b3.id, {
      status: "BUILDING", lease_token: "dead-worker", lease_expires_at: new Date(Date.now() - 60000).toISOString(),
    });
    const out3 = await drive(b3.id);
    const b3done = out3.build;
    check("a dead worker's build is reclaimed and recovers",
      out3.done && out3.status === "READY" && b3done.recovery_count === 1, `rc=${b3done.recovery_count}`);

    const req4 = await requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "android" });
    const b4 = await getBuild(req4.build.id);
    await svc.entities.MobileBuild.update(b4.id, {
      status: "BUILDING", lease_token: "dead-worker", lease_expires_at: new Date(Date.now() - 60000).toISOString(),
      recovery_count: MAX_MOBILE_BUILD_RECOVERIES,
    });
    const out4 = await drive(b4.id);
    const b4done = out4.build;
    check("recovery is bounded: past the ceiling the build fails terminally",
      out4.done && out4.status === "FAILED" && b4done.failure_code === "WORKER_LOST" && b4done.recovery_count === MAX_MOBILE_BUILD_RECOVERIES, b4done.failure_code);

    // ------------------------------------------------ quota: fail-closed, workspace-isolated
    planRow = await svc.entities.BillingPlan.create({
      code: "mobile_phase1_test", name: "Mobile Phase 1 Test Plan", interval: "monthly",
      price_cents: 0, included_credits: 0, tier_rank: 1, active: true,
      limits: { mobile_builds_per_day: 1 },
    });
    await svc.entities.Subscription.create({
      workspace_id: wsQ.id, plan_code: "mobile_phase1_test", status: "active",
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    const { project: pQ, version: vQ } = await mkProject(wsQ, "mb-quota-app");
    const fixQ = await mkFixture(wsQ, pQ, vQ, payloadUrl, "sha256:mobile-p1-q", 1);
    const q1 = await requestMobileBuild(base44, caller, { project_id: pQ.id, deployment_id: fixQ.deployment.id, platform: "ios" });
    await drive(q1.build.id);
    await expectThrow("at the daily ceiling the next mobile build is refused",
      () => requestMobileBuild(base44, caller, { project_id: pQ.id, deployment_id: fixQ.deployment.id, platform: "ios" }), "PLAN_LIMIT_REACHED");
    check("a refused request creates no build row",
      (await svc.entities.MobileBuild.filter({ workspace_id: wsQ.id }, "-created_date", 50)).length === 1, "still 1");
    const qIso = await requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "ios" });
    await getBuild(qIso.build.id);
    check("another workspace's counter never affects this one", !!qIso.build.id && qIso.build.status === "QUEUED", "isolated");

    // ------------------------------------------------ worker boundary requires auth
    const probe = await fetch("https://quick-zip-snap.base44.app/functions/mobileBuildStep", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ build_id: "x" }),
    });
    check("the mobile build worker requires worker auth", probe.status === 401, `${probe.status}`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    // Scratch cleanup: every record this suite created is removed.
    for (const id of track.builds) await svc.entities.MobileBuild.delete(id).catch(() => {});
    for (const id of track.deployments) await svc.entities.Deployment.delete(id).catch(() => {});
    for (const id of track.artifacts) await svc.entities.DeploymentArtifact.delete(id).catch(() => {});
    for (const id of track.versions) await svc.entities.ProjectVersion.delete(id).catch(() => {});
    for (const id of track.projects) await svc.entities.Project.delete(id).catch(() => {});
    if (planRow) await svc.entities.BillingPlan.delete(planRow.id).catch(() => {});
    for (const ws of [wsA, wsB, wsQ]) {
      await cleanupWorkspace(svc, ws?.id, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "WorkspaceSecret"]);
      if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }
}