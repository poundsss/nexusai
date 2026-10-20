// P-10.3 phase 2 regression suite — mobile signing credentials, binary artifact packaging and
// secure download.
//
// Certifies: a missing signing credential fails the build CLOSED (never an unsigned artifact);
// credentials are encrypted at rest, workspace-isolated, never exposed by the metadata view,
// and every change is audited; the package is a deterministic binary bundle of the immutable
// DeploymentArtifact (stable checksum, verified against storage, immutable after READY);
// downloads are authorized (deploy permission, owning workspace only), signed and short-lived;
// retries never duplicate artifacts; worker recovery still works. Web deployment behavior and
// the DeploymentArtifact schema are untouched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestMobileBuild, runMobileBuildStep, createMobileArtifactDownloadUrl } from "../../shared/mobileBuilds.ts";
import { putSigningCredential, removeSigningCredential, describeSigningCredentials, readSigningCredential, signingSecretName } from "../../shared/mobileSigning.ts";
import { sha256Hex } from "../../shared/mobileArtifacts.ts";
import { isEncrypted } from "../../shared/secretCrypto.ts";
import { createMobileBuildHarness } from "../../shared/mobileBuildTestFixtures.ts";
import { packJson } from "../../shared/blobStore.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ws1 = null, ws2 = null, wsX = null;
  const track = { projects: [], versions: [], deployments: [], artifacts: [], builds: [], members: [] };

  // The scratch fixtures (workspaces, projects, versions, deployment+artifact pairs, the
  // worker driver) come from the shared mobile build harness (see createMobileBuildHarness).

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const { drive, getBuild, mkWs, mkProject, mkFixture } = createMobileBuildHarness({ base44, svc, caller, track });
    ws1 = await mkWs("mba-a"); ws2 = await mkWs("mba-b"); wsX = await mkWs("mba-x");

    const payloadUrl = await packJson(svc, `mobile-p2-artifact-${Date.now()}.json`, {
      client_files: [
        { path: "index.html", content: "<html><body>phase2</body></html>" },
        { path: "app.js", content: "export default function App() { return 1; }" },
      ],
      functions: [{ name: "ping", source: "export default async () => 1;" }],
      entities: [{ name: "Item", fields: {} }],
      config: { entry: "index.html", framework: "preact-htm" },
    });
    const checksumA = "sha256:mobile-p2-a";
    const { project: p1, version: v1 } = await mkProject(ws1, "mba-a-app");
    const fix1 = await mkFixture(ws1, p1, v1, payloadUrl, checksumA);
    const { project: pX, version: vX } = await mkProject(wsX, "mba-x-app");
    const fixX = await mkFixture(wsX, pX, vX, payloadUrl, checksumA);

    // ------------------------------------------------ missing credential: fail closed
    const reqNoCred = await requestMobileBuild(base44, caller, { project_id: p1.id, deployment_id: fix1.deployment.id, platform: "ios" });
    const bNoCred = await getBuild(reqNoCred.build.id);
    const outNoCred = await drive(bNoCred.id);
    check("a missing signing credential fails the build closed",
      outNoCred.done && outNoCred.status === "FAILED" && outNoCred.build.failure_code === "MISSING_SIGNING_CREDENTIALS",
      outNoCred.build.failure_code);
    check("a failed build releases its lease safely",
      outNoCred.build.lease_token == null && outNoCred.build.lease_expires_at == null && !!outNoCred.build.completed_at,
      "released");
    check("the failed build writes its audit event",
      (await svc.entities.AuditLog.filter({ workspace_id: ws1.id, action: "mobile_build.failed" }, "-created_date", 20))
        .some((a) => a.resource_id === bNoCred.id),
      "audited");

    // ------------------------------------------------ credential lifecycle: encrypted, audited, isolated
    const put1 = await putSigningCredential(svc, { workspace_id: ws1.id, platform: "ios", value: "apple-p8-phase2-credential", user_id: caller.id });
    const secretRows = await svc.entities.WorkspaceSecret.filter({ workspace_id: ws1.id }, "name", 10);
    const iosRow = secretRows.find((r) => r.name === put1.secret_name);
    check("the signing credential is stored encrypted at rest",
      !!iosRow && isEncrypted(iosRow.value) && !String(iosRow.value).includes("apple-p8-phase2-credential"),
      "encrypted");
    check("credential creation is audited",
      (await svc.entities.AuditLog.filter({ workspace_id: ws1.id, action: "mobile_signing_credentials.created" }, "-created_date", 20))
        .some((a) => a.metadata?.platform === "ios"),
      "audited");
    await putSigningCredential(svc, { workspace_id: ws1.id, platform: "ios", value: "apple-p8-phase2-credential-2", user_id: caller.id });
    check("credential update is audited",
      (await svc.entities.AuditLog.filter({ workspace_id: ws1.id, action: "mobile_signing_credentials.updated" }, "-created_date", 20)).length > 0,
      "audited");
    await putSigningCredential(svc, { workspace_id: ws1.id, platform: "android", value: "android-ks-phase2-credential", user_id: caller.id });

    // The client-safe view exposes metadata only — never a value.
    const described = await describeSigningCredentials(svc, ws1.id);
    check("the credential view never exposes the value",
      !JSON.stringify(described).includes("phase2-credential") && described.find((c) => c.platform === "ios")?.is_set === true,
      "metadata only");

    // Workspace isolation: each workspace resolves only its own credential.
    await putSigningCredential(svc, { workspace_id: ws2.id, platform: "ios", value: "ws2-own-credential", user_id: caller.id });
    const ws1Cred = await readSigningCredential(svc, ws1.id, "ios");
    check("signing credentials are workspace-isolated", ws1Cred === "apple-p8-phase2-credential-2", ws1Cred);
    const del = await removeSigningCredential(svc, { workspace_id: ws2.id, platform: "ios", user_id: caller.id });
    check("credential deletion is audited",
      del.deleted && (await svc.entities.AuditLog.filter({ workspace_id: ws2.id, action: "mobile_signing_credentials.deleted" }, "-created_date", 20)).length > 0,
      "audited");
    check("a deleted credential reads as unset", (await readSigningCredential(svc, ws2.id, "ios")) === null, "unset");

    // ------------------------------------------------ package lifecycle
    const reqB1 = await requestMobileBuild(base44, caller, { project_id: p1.id, deployment_id: fix1.deployment.id, platform: "ios" });
    const b1 = await getBuild(reqB1.build.id);
    const outB1 = await drive(b1.id);
    const b1d = outB1.build;
    check("a build with credentials reaches READY", outB1.done && outB1.status === "READY", outB1.status);
    check("the READY build stores package metadata with credential identity and no signature",
      !!b1d.artifact_uri && /^[0-9a-f]{64}$/.test(b1d.package_checksum || "") && b1d.package_size_bytes > 0
      && !b1d.signed_at && b1d.signing_secret_name === signingSecretName("ios") && b1d.version_number === v1.number,
      b1d.package_checksum);
    check("the build stays pinned to the immutable source artifact", b1d.checksum === checksumA, b1d.checksum);

    // Stable checksum: a second build of the same artifact packages to the same bytes.
    const reqB2 = await requestMobileBuild(base44, caller, { project_id: p1.id, deployment_id: fix1.deployment.id, platform: "ios" });
    const b2 = await getBuild(reqB2.build.id);
    const outB2 = await drive(b2.id);
    check("the package checksum is stable across builds of the same artifact",
      outB2.build?.package_checksum === b1d.package_checksum, outB2.build?.package_checksum);

    // Immutable after READY: a retry neither rewrites the stored package nor duplicates rows.
    const beforeUri = b1d.artifact_uri, beforeChecksum = b1d.package_checksum;
    const reRun = await runMobileBuildStep(svc, b1.id);
    const b1After = await svc.entities.MobileBuild.get(b1.id);
    const rowsAfter = await svc.entities.MobileBuild.filter({ project_id: p1.id }, "-created_date", 50);
    // Three rows exist at this point (the credential-less FAILED build, b1, b2) — a duplicated
    // retry would make it four.
    check("a retry after READY changes nothing and duplicates nothing",
      reRun.done && reRun.status === "READY" && b1After.artifact_uri === beforeUri && b1After.package_checksum === beforeChecksum && rowsAfter.length === 3,
      `${rowsAfter.length} rows`);

    // ------------------------------------------------ secure download
    const dlMin = await createMobileArtifactDownloadUrl(base44, caller, { build_id: b1.id, expires_in: 5 });
    check("the download URL TTL is clamped to a short-lived minimum", dlMin.expires_in === 60, `${dlMin.expires_in}`);
    const dl = await createMobileArtifactDownloadUrl(base44, caller, { build_id: b1.id, expires_in: 99999 });
    check("the download URL TTL is clamped to a maximum", dl.expires_in === 3600, `${dl.expires_in}`);
    const pkgRes = await fetch(dl.signed_url);
    const pkgBytes = new Uint8Array(await pkgRes.arrayBuffer());
    check("the downloaded artifact verifies against the recorded checksum",
      pkgRes.ok && (await sha256Hex(pkgBytes)) === b1d.package_checksum && pkgBytes.length === b1d.package_size_bytes,
      "verified");

    // A queued build has no package to download; an unknown build id is simply not found.
    const reqQ = await requestMobileBuild(base44, caller, { project_id: p1.id, deployment_id: fix1.deployment.id, platform: "android" });
    await getBuild(reqQ.build.id);
    await expectThrow("a download of a build that is not READY is refused",
      () => createMobileArtifactDownloadUrl(base44, caller, { build_id: reqQ.build.id }), "NOT_READY");
    await expectThrow("an unknown build id is refused",
      () => createMobileArtifactDownloadUrl(base44, caller, { build_id: "nonexistent" }), "BUILD_NOT_FOUND");

    // ------------------------------------------------ workspace isolation of downloads
    await putSigningCredential(svc, { workspace_id: wsX.id, platform: "ios", value: "wsx-signing-credential", user_id: caller.id });
    const reqX = await requestMobileBuild(base44, caller, { project_id: pX.id, deployment_id: fixX.deployment.id, platform: "ios" });
    const bX = await getBuild(reqX.build.id);
    await drive(bX.id);
    // Strip the caller of every role in wsX: owner_id is a fact, not a grantable, so pointing it
    // at a nonexistent user removes all access.
    await svc.entities.Workspace.update(wsX.id, { owner_id: "user-nonexistent-phase2" });
    await expectThrow("a non-member of the owning workspace cannot download",
      () => createMobileArtifactDownloadUrl(base44, caller, { build_id: bX.id }), "NOT_A_MEMBER");
    const member = await svc.entities.WorkspaceMember.create({ workspace_id: wsX.id, user_id: caller.id, email: caller.email, role: "viewer", status: "active" });
    track.members.push(member.id);
    await expectThrow("a member without deploy permission cannot download",
      () => createMobileArtifactDownloadUrl(base44, caller, { build_id: bX.id }), "INSUFFICIENT_ROLE");
    await svc.entities.WorkspaceMember.delete(member.id).catch(() => {});
    await svc.entities.Workspace.update(wsX.id, { owner_id: caller.id });
    const dlOk = await createMobileArtifactDownloadUrl(base44, caller, { build_id: bX.id, expires_in: 300 });
    check("the owning workspace member can download again", !!dlOk.signed_url && dlOk.platform === "ios", "restored");

    // ------------------------------------------------ worker recovery still bounded and idempotent
    await svc.entities.MobileBuild.update(reqQ.build.id, {
      status: "BUILDING", lease_token: "dead-worker", lease_expires_at: new Date(Date.now() - 60000).toISOString(),
    });
    const outR = await drive(reqQ.build.id);
    check("a dead worker's build is reclaimed and recovers",
      outR.done && outR.status === "READY" && outR.build.recovery_count === 1, `rc=${outR.build?.recovery_count}`);

    // The worker boundary still requires auth.
    const probe = await fetch("https://quick-zip-snap.base44.app/functions/mobileBuildStep", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ build_id: "x" }),
    });
    check("the mobile build worker still requires worker auth", probe.status === 401, `${probe.status}`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    // Scratch cleanup: every record this suite created is removed.
    for (const id of track.members) await svc.entities.WorkspaceMember.delete(id).catch(() => {});
    for (const id of track.builds) await svc.entities.MobileBuild.delete(id).catch(() => {});
    for (const id of track.deployments) await svc.entities.Deployment.delete(id).catch(() => {});
    for (const id of track.artifacts) await svc.entities.DeploymentArtifact.delete(id).catch(() => {});
    for (const id of track.versions) await svc.entities.ProjectVersion.delete(id).catch(() => {});
    for (const id of track.projects) await svc.entities.Project.delete(id).catch(() => {});
    for (const ws of [ws1, ws2, wsX]) {
      await cleanupWorkspace(svc, ws?.id, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "WorkspaceSecret", "WorkspaceMember"]);
      if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }
}