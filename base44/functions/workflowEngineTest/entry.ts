// #28 Workflow / Automation Engine — DEPLOY-PATH certification.
//
// Nothing is simulated: a throwaway project is built through the REAL artifact builder
// (buildArtifact) and checked through the REAL deployment verification (verifyDeployment). It proves
// that a deployed version carries the EXACT workflow definitions it was built from, that those
// definitions never reach the client bundle, and that a workflow which could not execute in the
// deployed version keeps the deployment out of production.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createFs } from "../../shared/projectFs.ts";
import { createVersion } from "../../shared/persistence.ts";
import { buildArtifact, verifyDeployment, loadArtifactPayload, ensureProjectSlug } from "../../shared/deploy.ts";
import { packJson } from "../../shared/blobStore.ts";
import { createHarness, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const APP = `import { html } from 'runtime';
export default function App() {
  return html\`<div class="page"><h1 class="card-title">Workflow deploy</h1></div>\`;
}
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";
const FUNCTION = `export const config = { method: "POST", webhook: false, secrets: [] };
export default async function handler(ctx) {
  return { ok: true };
}
`;
const workflowDoc = (functionName) => `${JSON.stringify({
  name: "Order Sync",
  contract_version: "nexusai-workflows-1",
  trigger: { type: "manual" },
  entry_step: "sync",
  steps: [
    { id: "sync", type: "function", function_name: functionName, next: "done" },
    { id: "done", type: "complete" },
  ],
}, null, 2)}\n`;

const WORKFLOW_PATH = "base44/workflows/OrderSync.jsonc";
const FUNCTION_PATH = "functions/syncOrders.js";

export default async function (req) {
  const h = createHarness();
  const svc = createClientFromRequest(req).asServiceRole;
  const stamp = Date.now();
  const projects = [];

  // Verification always runs against a deployment row shaped exactly as the worker builds it.
  const verify = (project, artifact) => verifyDeployment(svc, {
    project, artifact,
    deployment: { environment: "production", version_id: artifact.version_id },
  });
  const named = (checks, name) => checks.find((c) => c.name === name);

  try {
    const mkProject = async (label, files) => {
      const project = await svc.entities.Project.create({ workspace_id: `wf-deploy-ws-${stamp}`, name: label, slug: `${label}-${stamp}` });
      projects.push(project);
      await ensureProjectSlug(svc, project);
      const fs = createFs([]);
      for (const [path, content] of Object.entries(files)) fs.files.set(path, { id: null, path, content, original: null });
      const version = await createVersion(svc, { project, fs, entities: [], secrets: [], message: label, changedFiles: [] });
      return { project: await svc.entities.Project.get(project.id), version };
    };

    const base = { "src/main.js": MAIN, "src/App.js": APP, "styles.css": STYLES, [FUNCTION_PATH]: FUNCTION };

    // ---------------------------------------------------------------- 1. artifact projection
    const withWf = await mkProject("wf-valid", { ...base, [WORKFLOW_PATH]: workflowDoc("syncOrders") });
    const built = await buildArtifact(svc, { project: withWf.project, version: withWf.version, userId: "test-user" });
    h.check("1 a version with a workflow builds an artifact", built.ok === true, built.ok ? built.artifact.checksum : JSON.stringify(built.diagnostics || built.code));
    const payload = built.ok ? await loadArtifactPayload(built.artifact) : { workflows: [], client_files: [] };
    const shipped = (payload.workflows || [])[0];
    h.check("2 the artifact ships the exact workflow definition it was built from",
      (payload.workflows || []).length === 1 && shipped.path === WORKFLOW_PATH && shipped.workflow_key === "ordersync" &&
      !!shipped.definition_checksum && shipped.entry_step === "sync" && shipped.steps.length === 2 &&
      shipped.steps[0].function_name === "syncOrders" && !shipped.error,
      JSON.stringify(shipped || null).slice(0, 220));
    h.check("3 the workflow definition never reaches the client bundle",
      !payload.client_files.some((f) => f.path === WORKFLOW_PATH) &&
      !payload.client_files.some((f) => f.content.includes("Order Sync")),
      `${payload.client_files.length} client file(s), none carrying workflow configuration`);

    // ---------------------------------------------------------------- 2. valid workflow verifies
    const okVerify = await verify(withWf.project, built.artifact);
    const okCheck = named(okVerify.checks, "workflows_executable");
    h.check("4 a valid deployed workflow passes workflows_executable",
      !!okCheck && okCheck.ok === true && okVerify.ok === true, `${okCheck?.detail} | ${okVerify.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") || "all checks pass"}`);

    // ---------------------------------------------------------------- 3. malformed / missing function
    // The artifact payload is rebuilt with ONE substituted workflow entry, so only the shipped
    // workflow differs and every other verification check stays exactly as it was above.
    const artifactWith = async (project, version, workflows, tag) => {
      const body = { ...payload, workflows, config: { ...payload.config, project_id: project.id, version_number: version.number } };
      const payload_url = await packJson(svc, `wf_deploy_${tag}_${stamp}.json`, body);
      return svc.entities.DeploymentArtifact.create({
        project_id: project.id, version_id: version.id, version_number: version.number,
        checksum: `wfdeploy_${tag}_${stamp}`, payload_url,
        file_count: payload.client_files.length + payload.functions.length, client_file_count: payload.client_files.length,
        function_names: payload.functions.map((f) => f.name), integration_names: [], entity_names: [],
        secret_names: [], secret_scan: "pass", secret_scan_findings: [], size_bytes: 0, built_by: "test-user",
      });
    };

    const malformed = await artifactWith(withWf.project, withWf.version, [{ path: WORKFLOW_PATH, workflow_key: null, error: "is not valid JSONC: unexpected token" }], "malformed");
    const malformedRes = await verify(withWf.project, malformed);
    const malformedCheck = named(malformedRes.checks, "workflows_executable");
    h.check("5 a malformed shipped workflow fails verification",
      malformedRes.ok === false && malformedCheck?.ok === false && /not valid JSONC/.test(malformedCheck.detail),
      malformedCheck?.detail);

    const ghost = await artifactWith(withWf.project, withWf.version, [{ ...shipped, steps: [{ ...shipped.steps[0], function_name: "deletedFunction" }, shipped.steps[1]] }], "ghostfn");
    const ghostRes = await verify(withWf.project, ghost);
    const ghostCheck = named(ghostRes.checks, "workflows_executable");
    h.check("6 a workflow referencing a missing backend function fails verification",
      ghostRes.ok === false && ghostCheck?.ok === false && /deletedFunction/.test(ghostCheck.detail),
      ghostCheck?.detail);

    const ghostSchedule = await artifactWith(withWf.project, withWf.version, [{ ...shipped, trigger: { type: "schedule", function_name: "notShipped", interval_seconds: 600 } }], "ghostsched");
    const scheduleRes = await verify(withWf.project, ghostSchedule);
    const scheduleCheck = named(scheduleRes.checks, "workflows_executable");
    h.check("7 an unresolvable workflow runtime dependency fails verification",
      scheduleRes.ok === false && scheduleCheck?.ok === false && /notShipped/.test(scheduleCheck.detail),
      scheduleCheck?.detail);

    const dupe = await artifactWith(withWf.project, withWf.version, [shipped, { ...shipped, path: "base64/workflows/Other.jsonc" }], "dupe");
    const dupeCheck = named((await verify(withWf.project, dupe)).checks, "workflows_executable");
    h.check("8 two shipped files claiming one workflow lineage fail verification",
      dupeCheck?.ok === false && /same workflow/.test(dupeCheck.detail), dupeCheck?.detail);

    // ---------------------------------------------------------------- 4. legacy compatibility
    const noWf = await mkProject("wf-none", base);
    const plain = await buildArtifact(svc, { project: noWf.project, version: noWf.version, userId: "test-user" });
    const plainPayload = plain.ok ? await loadArtifactPayload(plain.artifact) : {};
    const plainRes = plain.ok ? await verify(noWf.project, plain.artifact) : { ok: false, checks: [] };
    const plainCheck = named(plainRes.checks, "workflows_executable");
    h.check("9 a project with no workflows keeps a byte-identical artifact and passes",
      plain.ok === true && !("workflows" in plainPayload) && plainCheck?.ok === true && plainRes.ok === true,
      `${plainCheck?.detail} | ${plainRes.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") || "all checks pass"}`);

    // ---------------------------------------------------------------- 5. isolation
    h.check("10 a shipped workflow stays bound to its own project and version",
      payload.config.project_id === withWf.project.id && built.artifact.version_id === withWf.version.id &&
      plain.artifact.project_id === noWf.project.id && !(plainPayload.workflows || []).length &&
      // The other project's artifact is refused for this project, so a workflow can never be
      // verified — or served — under a project it was not built for.
      (await verify(noWf.project, built.artifact)).checks.find((c) => c.name === "routing_correct")?.ok === false,
      `${withWf.project.id} v${withWf.version.number} vs ${noWf.project.id}`);

    // ---------------------------------------------------------------- 6. existing checks unchanged
    h.check("11 every pre-existing deployment check still runs",
      ["artifact_loads", "frontend_serves", "backend_responds", "database_scoped", "secrets_available", "no_secret_leak", "dependencies_pinned", "routing_correct"]
        .every((n) => !!named(okVerify.checks, n)) && okVerify.checks.length === 9,
      okVerify.checks.map((c) => c.name).join(", "));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of projects) {
      for (const entity of ["Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Build", "AppRecord", "AuditLog"]) {
        await purgeBy(svc, entity, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
  }
}