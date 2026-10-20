// Targeted certification for the two deployed-host runtime gaps (PublicApp.jsx host only):
//   * runtime:navigate — URL/history synchronization + boot-time deep-link
//   * runtime:error    — host-visible surfacing of the sandboxed app's errors
// It builds ONE disposable fixture app, deploys it LIVE through the REAL deployment worker
// (shared/deployFixtures.createDeployedApp), and the browser-level checks run against
// /app/<slug> in the preview. Cleanup removes every created row.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createDeployedApp, MINIMAL_MAIN, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";

// The fixture app exercises BOTH gaps: useRoute() renders the current in-app path (so the
// deep-link boot and every history ack are observable as a runtime:navigate back to the host),
// a button-side navigate() is driven by the host via runtime:goto, and one deferred
// unhandledrejection produces the runtime:error the host must surface.
const APP_SOURCE = `import { html, navigate, useRoute } from 'runtime';
let boomed = false;
export default function App() {
  const route = useRoute();
  if (!boomed) { boomed = true; setTimeout(() => { Promise.reject(new Error('runtime boom: deferred failure')); }, 2500); }
  return html\`<div class="page">
    <h1 class="card-title" id="route-display">\${route}</h1>
    <button id="nav-second" onClick=\${() => navigate('/second')}>Go second</button>
  </div>\`;
}
`;

export default async function (req) {
  const client = createClientFromRequest(req);
  const svc = client.asServiceRole;
  const body = await req.json();
  const mode = String(body.mode || "deploy");

  if (mode === "deploy") {
    const { project, run } = await createDeployedApp(svc, {
      workspace_id: String(body.workspace_id || ""),
      name: "Host Runtime Gap Fixture",
      slug: String(body.slug || "host-runtime-gap-fixture"),
      deployed_by: String(body.deployed_by || ""),
      files: [
        [ENTRY_FILE, MINIMAL_MAIN],
        ["src/App.js", APP_SOURCE],
        ["styles.css", MINIMAL_STYLES],
      ],
    });
    return Response.json({
      ok: run.status === "LIVE",
      project_id: project.id,
      slug: project.slug,
      deployment_status: run.status,
      environment: "production",
    });
  }

  // cleanup: remove every row the fixture created (the app was only ever served from these).
  const projectId = String(body.project_id || "");
  if (!projectId) return Response.json({ error: "cleanup requires project_id" }, { status: 400 });
  await svc.entities.ProjectFile.deleteMany({ project_id: projectId });
  await svc.entities.ProjectVersion.deleteMany({ project_id: projectId });
  await svc.entities.Deployment.deleteMany({ project_id: projectId });
  await svc.entities.DeploymentArtifact.deleteMany({ project_id: projectId });
  await svc.entities.Project.delete(projectId);
  return Response.json({ cleaned: true, project_id: projectId });
}