// P-10.3 phase 2 completion certification — the mobile signing execution chain.
//
// Certifies the REAL signing path added by shared/mobileSigningChain.ts end-to-end, WITHOUT
// touching the certified build worker (which still stamps no signed_at), the store worker, the
// entities, or the scheduler:
//   • the build worker still produces a READY build with NO signed_at (the certified Phase-2
//     contract); the signing execution is the step that completes it
//   • signMobileBuild stamps signed_at + the credential IDENTITY (never the value), reports the
//     deterministic HMAC-SHA256 signature checksum, and persists a verifiable signature
//   • the signature is reproducible from the stored package + the workspace credential
//     (notarization) — the same bytes always sign to the same checksum
//   • re-signing an already-signed build is a no-op (terminal-never-overwritten)
//   • a build that is not READY cannot be signed; a non-member cannot sign (RBAC, server-side)
//   • the signing execution is audited with the signature identity and no credential material
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestMobileBuild } from "../../shared/mobileBuilds.ts";
import { createMobileBuildHarness } from "../../shared/mobileBuildTestFixtures.ts";
import { signMobileBuild, signPackageBytes, SIGNATURE_ALGORITHM } from "../../shared/mobileSigningChain.ts";
import { readSigningCredential, signingSecretName } from "../../shared/mobileSigning.ts";
import { sha256Hex } from "../../shared/mobileArtifacts.ts";
import { packJson } from "../../shared/blobStore.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ws = null;
  const track = { projects: [], versions: [], deployments: [], artifacts: [], builds: [] };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const { drive, getBuild, mkWs, mkProject, mkFixture, provisionSigning } = createMobileBuildHarness({ base44, svc, caller, track });
    ws = await mkWs("msign-a");
    await provisionSigning(ws, ["ios"]);

    const payloadUrl = await packJson(svc, `mobile-sign-artifact-${Date.now()}.json`, {
      client_files: [{ path: "index.html", content: "<html><body>sign</body></html>" }],
      functions: [], config: { entry: "index.html", framework: "preact-htm" },
    });
    const { project: p, version: v } = await mkProject(ws, "msign-app");
    const fix = await mkFixture(ws, p, v, payloadUrl, "sha256:msign-a");

    // ------------------------------------------------ the certified worker: READY, no signed_at
    const req1 = await requestMobileBuild(base44, caller, { project_id: p.id, deployment_id: fix.deployment.id, platform: "ios" });
    const b1 = await getBuild(req1.build.id);
    const out1 = await drive(b1.id);
    check("the build worker reaches READY with no signed_at (signing is the external step)",
      out1.done && out1.status === "READY" && !out1.build.signed_at, out1.build?.signed_at || "no signed_at");

    // ------------------------------------------------ the actual signing execution
    const signed = await signMobileBuild(base44, caller, { build_id: b1.id });
    check("signing stamps signed_at on the build", !!signed.signed_at && signed.already_signed === false, signed.signed_at);
    check("signing records the credential IDENTITY, never the value",
      signed.signing_secret_name === signingSecretName("ios") && !JSON.stringify(signed).includes("signing-credential"),
      signed.signing_secret_name);
    check("signing reports the deterministic HMAC-SHA256 signature checksum",
      signed.signature_algorithm === SIGNATURE_ALGORITHM && /^[0-9a-f]{64}$/.test(signed.signature_checksum || ""),
      signed.signature_checksum);

    const b1signed = await svc.entities.MobileBuild.get(b1.id);
    check("the build row now carries signed_at and the credential identity",
      !!b1signed.signed_at && b1signed.signed_at === signed.signed_at && b1signed.signing_secret_name === signingSecretName("ios"),
      b1signed.signed_at);
    // This is exactly the gate the store-publish VALIDATING phase checks (build.signed_at); the
    // signing execution makes it pass instead of failing closed with SIGNING_INCOMPLETE.
    check("the signed build now passes the store SIGNING_INCOMPLETE gate", !!b1signed.signed_at, "signed");

    // ------------------------------------------------ idempotent: an already-signed build is never re-signed
    const reSigned = await signMobileBuild(base44, caller, { build_id: b1.id });
    check("re-signing an already-signed build is a no-op",
      reSigned.already_signed === true && reSigned.signed_at === signed.signed_at, `${reSigned.already_signed}`);
    const b1after = await svc.entities.MobileBuild.get(b1.id);
    check("the signed_at stamp is stable across re-sign calls", b1after.signed_at === signed.signed_at, "stable");

    // ------------------------------------------------ notarization: the signature is reproducible from package + credential
    const credential = await readSigningCredential(svc, ws.id, "ios");
    const { signed_url } = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: b1signed.artifact_uri, expires_in: 60 });
    const pkgRes = await fetch(signed_url);
    const pkgBytes = new Uint8Array(await pkgRes.arrayBuffer());
    const recomputed = await signPackageBytes(credential, pkgBytes);
    check("the recorded signature is reproducible from the package + credential (notarization)",
      (await sha256Hex(recomputed)) === signed.signature_checksum, "verified");

    // ------------------------------------------------ authorization: a non-member cannot sign
    await expectThrow("a non-member cannot sign a build",
      () => signMobileBuild(base44, { id: "msign-ghost-user-000000", email: "ghost@example.invalid" }, { build_id: b1.id }), "NOT_A_MEMBER");

    // ------------------------------------------------ a build that is not READY cannot be signed
    const reqQ = await requestMobileBuild(base44, caller, { project_id: p.id, deployment_id: fix.deployment.id, platform: "ios" });
    await getBuild(reqQ.build.id); // left QUEUED on purpose
    await expectThrow("a build that is not READY cannot be signed",
      () => signMobileBuild(base44, caller, { build_id: reqQ.build.id }), "NOT_READY");

    // ------------------------------------------------ the signing execution is audited
    const audited = (await svc.entities.AuditLog.filter({ workspace_id: ws.id, action: "mobile_build.signed" }, "-created_date", 20))
      .some((a) => a.resource_id === b1.id && a.metadata?.signature_algorithm === SIGNATURE_ALGORITHM
        && !JSON.stringify(a.metadata || {}).includes("signing-credential"));
    check("the signing execution is audited with the signature identity and no credential material",
      audited, "audited");

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
    await cleanupWorkspace(svc, ws?.id, ["AuditLog", "WorkspaceSecret"]);
    if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
  }
}