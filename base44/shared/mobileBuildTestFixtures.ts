// Shared fixtures for the mobile build suites (mobileBuildTest, mobileBuildArtifactTest): the
// real-worker driver with stale-read re-reads, tracked build reads, scratch workspace/project/
// version creation, a LIVE deployment + immutable artifact fixture, and signing-credential
// provisioning. Both suites exercise the REAL worker and the REAL packaging path — nothing is
// simulated — so the helpers live in one module instead of being copied between suites.
import { runMobileBuildStep } from "./mobileBuilds.ts";
import { putSigningCredential } from "./mobileSigning.ts";
import { createProjectForUser } from "./projectCreate.ts";

export function createMobileBuildHarness({ base44, svc, caller, track }) {
  // Advance a build with the worker until it reports done, then re-read until the row reflects
  // the reported status — a read issued immediately after the terminal write can still observe
  // the pre-terminal row (same pattern as the deployment environments suite).
  const drive = async (buildId, maxSteps = 8) => {
    let last = null;
    for (let i = 0; i < maxSteps; i++) {
      last = await runMobileBuildStep(svc, buildId);
      if (last.done) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    let build = await svc.entities.MobileBuild.get(buildId);
    for (let i = 0; i < 5 && last?.status && build.status !== last.status; i++) {
      await new Promise((r) => setTimeout(r, 250));
      build = await svc.entities.MobileBuild.get(buildId);
    }
    return { ...last, build };
  };

  // Reads a build row for assertion and registers it for scratch cleanup.
  const getBuild = async (id) => {
    track.builds.push(id);
    return svc.entities.MobileBuild.get(id);
  };

  const mkWs = async (name) => svc.entities.Workspace.create({
    name: `${name}-${Date.now()}`, owner_id: caller.id, credits_balance: 0, status: "active",
  });

  const mkProject = async (ws, name) => {
    const created = await createProjectForUser(base44, caller, { workspace_id: ws.id, name });
    const project = created.project;
    track.projects.push(project.id);
    const version = await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "mobile build cert" });
    track.versions.push(version.id);
    return { project, version };
  };

  // A LIVE deployment fixture serving an immutable artifact whose payload lives at payloadUrl —
  // exactly the precondition a mobile build request pins itself to.
  const mkFixture = async (ws, project, version, payloadUrl, checksum) => {
    const artifact = await svc.entities.DeploymentArtifact.create({
      project_id: project.id, version_id: version.id, version_number: version.number,
      checksum, payload_url: payloadUrl, file_count: 2, client_file_count: 2,
      secret_scan: "pass", size_bytes: 256, built_by: "test",
    });
    track.artifacts.push(artifact.id);
    const deployment = await svc.entities.Deployment.create({
      project_id: project.id, workspace_id: ws.id, version_id: version.id, version_number: version.number,
      status: "LIVE", artifact_id: artifact.id, artifact_checksum: checksum,
      environment: "production", trigger: "user",
    });
    track.deployments.push(deployment.id);
    return { artifact, deployment };
  };

  // Provision signing credentials — the SIGNING phase fails closed without one.
  const provisionSigning = async (ws, platforms) => {
    for (const platform of platforms) {
      await putSigningCredential(svc, { workspace_id: ws.id, platform, value: `${platform}-signing-credential`, user_id: caller.id });
    }
  };

  return { drive, getBuild, mkWs, mkProject, mkFixture, provisionSigning };
}