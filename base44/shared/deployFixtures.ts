// Shared fixtures for suites that exercise the DEPLOYED public runtime (appRuntime) over its
// real HTTP surface against a real live deployment. One module owns how such a suite builds its
// project + version + deployment fixture and how it invokes the runtime, so every suite drives
// the REAL worker and reads refusals identically instead of re-implementing the pattern.
import { createFs, writeFile, activeFiles } from "./projectFs.ts";
import { createVersion } from "./persistence.ts";
import { ENTRY_FILE } from "./runtimeExports.ts";
import { runDeploymentStep, ensureProjectSlug, deploymentPath } from "./deploy.ts";

// The minimal generated-app source a deployment needs: entry + one page + styles.
export const MINIMAL_MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
export const MINIMAL_APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">App</h1></div>\`; }
`;
export const MINIMAL_STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";

/**
 * Drives a deployment to a terminal state through the REAL worker, exactly as the background
 * executor workflow does.
 */
// Drives until the worker reports done (a fully built app), bounded by `max` steps AND a wall
// clock — a slow build is driven to completion instead of being reported as BUILDING.
export async function driveDeployment(svc, deploymentId, max = 40, deadlineMs = 120000) {
  let out = null;
  const deadline = Date.now() + deadlineMs;
  for (let i = 0; i < max && Date.now() < deadline; i++) {
    out = await runDeploymentStep(svc, deploymentId);
    if (out.done) break;
  }
  let deployment = await svc.entities.Deployment.get(deploymentId);
  for (let i = 0; i < 5 && out?.status && deployment.status !== out.status; i++) {
    await new Promise((r) => setTimeout(r, 250));
    deployment = await svc.entities.Deployment.get(deploymentId);
  }
  return { ...out, deployment };
}

/**
 * Creates a project with the given files, one version, and drives a REAL production deployment
 * of it through the worker. `files` overrides the default minimal app ([path, content] pairs),
 * `extra_files` are appended, `on_project_created` observes the fresh Project row.
 * Returns { project, version, fs, run } with `run` the deployment drive result.
 */
export async function createDeployedApp(svc, {
  workspace_id, name, slug, deployed_by,
  files = null, extra_files = [], entities = [], rls_enabled = false,
  on_project_created = null,
}) {
  const p = await svc.entities.Project.create({
    workspace_id, name, slug, framework: "preact-htm", status: "draft", version_count: 0,
    ...(rls_enabled ? { rls_enabled } : {}),
  });
  if (on_project_created) await on_project_created(p);
  const fs = createFs([]);
  const base = files || [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", MINIMAL_APP], ["styles.css", MINIMAL_STYLES]];
  for (const [path, content] of base) writeFile(fs, path, content);
  for (const [path, content] of extra_files) writeFile(fs, path, content);
  for (const f of activeFiles(fs)) await svc.entities.ProjectFile.create({ project_id: p.id, path: f.path, content: f.content });
  const version = await createVersion(svc, { project: p, fs, entities, secrets: [], message: `${name} v1`, changedFiles: [] });
  const project = await svc.entities.Project.get(p.id);
  const now = new Date().toISOString();
  const depSlug = await ensureProjectSlug(svc, project);
  const d = await svc.entities.Deployment.create({
    project_id: project.id, workspace_id: project.workspace_id, version_id: version.id, version_number: version.number,
    environment: "production", status: "QUEUED", trigger: "user", deployment_url: deploymentPath(depSlug, "production"),
    deployed_by, cancel_requested: false, recovery_count: 0, started_at: now, heartbeat_at: now,
  });
  const run = await driveDeployment(svc, d.id);
  return { project: await svc.entities.Project.get(p.id), version, fs, run };
}

/**
 * The appRuntime invoke wrapper: one canonical way to call the deployed public runtime,
 * capturing both the success body ({ status, data }) and a refusal's status/error code.
 */
export function appRuntimeCaller(svc) {
  return (body) =>
    svc.functions.invoke("appRuntime", body)
      .then((r) => ({ ok: true, status: r.status ?? 200, data: r.data ?? r }))
      .catch((e) => {
        const d = (e && (e.response?.data ?? e.data)) || null;
        return {
          ok: false, status: e.status || e.response?.status || 0,
          code: d?.code || e.code || null, data: d || { error: e.message }, error: d?.error || String(e.message || e),
        };
      });
}