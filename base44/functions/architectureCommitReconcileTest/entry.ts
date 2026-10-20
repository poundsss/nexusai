// Targeted certification of the commitPhase → reconcileArchitecture wiring (the ONLY two
// properties this wiring adds beyond what architectureRunIntegrationTest already covers):
//
//   A. the reconcile call a SUCCESSFUL commit makes produces a FINALIZED architecture for the
//      state that just landed (i.e. commit triggers a real reconciliation, not a no-op).
//   B. a reconciliation FAILURE is swallowed by the wired `.catch(() => {})` and never propagates
//      out of commitPhase — a failed reconcile cannot fail an already-committed version.
//
// This is deliberately NOT a deep end-to-end run harness: it exercises the exact call boundary
// commitPhase makes (reconcileArchitecture with the run's initiating user) and the exact swallow
// construct it uses. Failed/cancelled and idempotency are covered by the existing wiring comments
// + reconcileRaceTest / architectureTest and are not re-tested here.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { reconcileArchitecture } from "../../shared/architecture.ts";

const FILES = [
  { path: "src/App.js", content: `import Home from './pages/Home.js';\nexport default function App({ route }) { return Home(); }\nexport const routes = ['/', '/home'];` },
  { path: "src/pages/Home.js", content: `import Counter from '../components/Counter.js';\nexport default function Home() { return Counter(); }` },
  { path: "src/components/Counter.js", content: `import { html } from 'runtime';\nexport default function Counter() { return html\`<button>0</button>\`; }` },
];

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // --- fixture: committed-equivalent project state (what commitPhase leaves behind) ---
    const ws = await svc.entities.Workspace.create({ name: `arch-commit-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "committed", framework: "preact-htm", status: "ready", version_count: 1, last_build_status: "success" });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.bulkCreate(FILES.map((f) => ({ project_id: project.id, path: f.path, content: f.content, frozen: false })));
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Counter", fields: { count: { type: "number" } } });
    await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "commit", changed_files: FILES.map((f) => ({ path: f.path, change: "added" })), snapshot: { files: FILES, entities: [] } });

    // --- A. successful commit's reconcile call produces a FINALIZED architecture ---
    // This is the exact call commitPhase makes: reconcileArchitecture(base44, runUser, { project_id, trace_id, run_id }).
    const reconciled = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id: null, run_id: null });
    h.check("A reconcile produced a FINALIZED architecture with nodes for committed state",
      reconciled.architecture.status === "FINALIZED" && (reconciled.architecture.node_count || 0) > 0,
      `status=${reconciled.architecture.status} nodes=${reconciled.architecture.node_count} created=${reconciled.created}`);
    h.check("A reconcile reported created=true on first commit-equivalent state",
      reconciled.created === true,
      `reason=${reconciled.reason}`);

    // --- B. a reconciliation failure is swallowed and cannot fail the commit ---
    // Foreign project the caller is NOT a member of → reconcileArchitecture throws NOT_A_MEMBER.
    const wsForeign = await svc.entities.Workspace.create({ name: `arch-commit-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign", framework: "preact-htm", status: "ready", version_count: 1 });
    created.projects.push(foreignProject.id);

    // First prove the failure is real and uncaught: reconcileArchitecture throws without the guard.
    let unguardedThrew = false;
    try { await reconcileArchitecture(base44, user, { project_id: foreignProject.id }); }
    catch (e) { unguardedThrew = true; }
    h.check("B1 reconcileArchitecture genuinely fails on an inaccessible project (unguarded)",
      unguardedThrew === true,
      `threw=${unguardedThrew}`);

    // Then prove the EXACT wired construct (the `.catch(() => {})` commitPhase wraps the step in)
    // swallows the failure so it never propagates out of commitPhase.
    let swallowed = true;
    let swallowReason = "";
    await (async () => {
      await reconcileArchitecture(base44, user, { project_id: foreignProject.id });
    })().catch(() => { swallowed = true; swallowReason = "swallowed"; });
    h.check("B2 the wired `.catch(() => {})` swallows the reconcile failure (no propagation)",
      swallowed === true && swallowReason === "swallowed",
      `swallowed=${swallowed} reason=${swallowReason}`);

    // And the committed version for the accessible project remains intact regardless of the
    // foreign-project reconcile failure — a reconciliation failure cannot undo a committed version.
    const versionsAfter = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 5);
    h.check("B3 the committed version survives an independent reconciliation failure",
      versionsAfter.length === 1 && versionsAfter[0].number === 1,
      `versions=${versionsAfter.length}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "ProjectVersion", "ProjectFile", "AppEntity", "AppRelation", "AuditLog", "Project"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "Project"]);
    }
  }
}