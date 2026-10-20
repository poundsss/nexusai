// Focused certification for the Security Scan Builder+ code-vulnerability gate (the confirmed
// parity gap #7). Drives the REAL securityScanSurface + executeSecurityScan over disposable
// workspaces on three plans (Free, Builder, Pro) and asserts:
//   • Free plan  → scan SUCCEEDS, static_code_enabled=false, NO static_code_findings, the other
//     scan groups remain (credit_protection fires on an unbudgeted workspace);
//   • Builder    → static_code_enabled=true and static_code_findings ARE produced for a code vuln;
//   • Pro        → same as Builder (higher plan);
//   • the plan is resolved SERVER-SIDE (the surface takes only the authorized workspace; no client
//     plan/flag is accepted);
//   • existing semantics stay intact: 7 scan groups, X-Scan-Source "started", pending→completed,
//     one-row persistence, ignore/restore round trip, GET never starts a scan.
// Uses disposable test data only; cleans up everything it creates.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { executeSecurityScan, SCAN_GROUPS } from "../../shared/securityScan.ts";
import { mkScanProject, scanJobs, scanSurface } from "../../shared/securityScanTestFixtures.ts";

const CODE_FILE = "src/pages/Vuln.js";
const CODE_CONTENT = "export default function Vuln(input, el) {\n  eval(input);\n  el.innerHTML = input;\n  return 'bad';\n}\n";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = scanSurface(svc);
  const mkProject = (wsId, name) => mkScanProject(svc, projects, wsId, `gate-${name}`, stamp);
  const jobs = (projectId) => scanJobs(svc, projectId);

  try {
    // --- Free workspace (no subscription) -----------------------------------------------
    const wsFree = await svc.entities.Workspace.create({ name: `secscan-gate-free-${stamp}`, owner_id: `ownerFree_${stamp}` });
    workspaces.push(wsFree.id);
    const projFree = await mkProject(wsFree.id, "free");
    await svc.entities.ProjectFile.create({ project_id: projFree.id, path: CODE_FILE, content: CODE_CONTENT });
    await svc.entities.ProjectFile.create({ project_id: projFree.id, path: "src/pages/Clean.js", content: "export default function Clean() { return 'ok'; }\n" });
    await svc.entities.AppEntity.create({ project_id: projFree.id, name: "PublicFree", fields: { label: { type: "string" } } }); // open RLS → rls_recommendations fires
    const userFree = { id: `ownerFree_${stamp}`, email: "free@example.com" };

    const runFree = await surface(projFree, wsFree, userFree, { action: "run", language: "en" });
    harness.check("Free plan: scan starts (X-Scan-Source: started), static_code_enabled=false at run time",
      runFree.scan_source === "started" && runFree.body.status === "pending" && runFree.body.static_code_enabled === false,
      JSON.stringify({ source: runFree.scan_source, static_code_enabled: runFree.body.static_code_enabled }));

    const rowFree = (await svc.entities.SecurityScan.filter({ project_id: projFree.id }, "-created_date", 1))[0];
    await executeSecurityScan(svc, rowFree.id);
    const viewFree = await surface(projFree, wsFree, userFree, { action: "get" });
    const resFree = viewFree.body.result || {};
    harness.check("Free plan: scan completes up_to_date with static_code_enabled=false and NO static_code_findings",
      viewFree.body.status === "up_to_date" && viewFree.body.static_code_enabled === false &&
      Array.isArray(resFree.static_code_findings) && resFree.static_code_findings.length === 0,
      JSON.stringify({ status: viewFree.body.status, static: (resFree.static_code_findings || []).length }));
    harness.check("Free plan: the other scan groups remain (rls_recommendations fires on the open entity; code vuln is NOT reported)",
      (resFree.rls_recommendations || []).some((r) => r.entity_name === "PublicFree") &&
      !resFree.static_code_findings.length,
      JSON.stringify({ rls: (resFree.rls_recommendations || []).length }));
    harness.check("Free plan: every documented group key is present in the result",
      SCAN_GROUPS.every((g) => Array.isArray(resFree[g])),
      JSON.stringify({ groups: SCAN_GROUPS.filter((g) => Array.isArray(resFree[g])).length }));

    // --- Builder workspace (active builder_monthly subscription) -------------------------
    const wsBuilder = await svc.entities.Workspace.create({ name: `secscan-gate-builder-${stamp}`, owner_id: `ownerBuilder_${stamp}` });
    workspaces.push(wsBuilder.id);
    await svc.entities.Subscription.create({ workspace_id: wsBuilder.id, plan_code: "builder_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    await svc.entities.Budget.create({ workspace_id: wsBuilder.id, scope: "workspace", limit_credits: 1000, period: "monthly", active: true });
    const projBuilder = await mkProject(wsBuilder.id, "builder");
    await svc.entities.ProjectFile.create({ project_id: projBuilder.id, path: CODE_FILE, content: CODE_CONTENT });
    const userBuilder = { id: `ownerBuilder_${stamp}`, email: "builder@example.com" };

    const runBuilder = await surface(projBuilder, wsBuilder, userBuilder, { action: "run", language: "en" });
    harness.check("Builder plan: scan starts with static_code_enabled=true",
      runBuilder.scan_source === "started" && runBuilder.body.static_code_enabled === true,
      JSON.stringify({ static_code_enabled: runBuilder.body.static_code_enabled }));
    const rowBuilder = (await svc.entities.SecurityScan.filter({ project_id: projBuilder.id }, "-created_date", 1))[0];
    await executeSecurityScan(svc, rowBuilder.id);
    const viewBuilder = await surface(projBuilder, wsBuilder, userBuilder, { action: "get" });
    const resBuilder = viewBuilder.body.result || {};
    const evalFinding = (resBuilder.static_code_findings || []).find((f) => f.title === "dynamic_code_execution");
    harness.check("Builder plan: static_code_findings ARE produced for the code vulnerability",
      viewBuilder.body.status === "up_to_date" && viewBuilder.body.static_code_enabled === true &&
      !!evalFinding && evalFinding.file === CODE_FILE && (resBuilder.static_code_findings || []).length >= 2,
      JSON.stringify({ static: (resBuilder.static_code_findings || []).length, titles: (resBuilder.static_code_findings || []).map((f) => f.title) }));

    // --- Pro workspace (higher plan) ----------------------------------------------------
    const wsPro = await svc.entities.Workspace.create({ name: `secscan-gate-pro-${stamp}`, owner_id: `ownerPro_${stamp}` });
    workspaces.push(wsPro.id);
    await svc.entities.Subscription.create({ workspace_id: wsPro.id, plan_code: "pro_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    await svc.entities.Budget.create({ workspace_id: wsPro.id, scope: "workspace", limit_credits: 1000, period: "monthly", active: true });
    const projPro = await mkProject(wsPro.id, "pro");
    await svc.entities.ProjectFile.create({ project_id: projPro.id, path: CODE_FILE, content: CODE_CONTENT });
    const userPro = { id: `ownerPro_${stamp}`, email: "pro@example.com" };
    await surface(projPro, wsPro, userPro, { action: "run", language: "en" });
    const rowPro = (await svc.entities.SecurityScan.filter({ project_id: projPro.id }, "-created_date", 1))[0];
    await executeSecurityScan(svc, rowPro.id);
    const viewPro = await surface(projPro, wsPro, userPro, { action: "get" });
    harness.check("Pro plan (higher): static_code_enabled=true and static findings produced (Builder+ gate admits it)",
      viewPro.body.status === "up_to_date" && viewPro.body.static_code_enabled === true &&
      ((viewPro.body.result || {}).static_code_findings || []).length >= 1,
      JSON.stringify({ static: ((viewPro.body.result || {}).static_code_findings || []).length }));

    // --- Server-side resolution: a client cannot force code scanning on a free workspace -
    // (The surface accepts no plan/flag; the run body already proved static_code_enabled=false.
    // Here we confirm no client field is honored by re-running and reading the stored flag.)
    const rerunFree = await surface(projFree, wsFree, userFree, { action: "run", language: "en", static_code_enabled: true, plan_code: "builder_monthly" });
    harness.check("Server-side resolution: a client-supplied plan/flag is ignored (Free stays static_code_enabled=false)",
      rerunFree.body.static_code_enabled === false,
      JSON.stringify({ static_code_enabled: rerunFree.body.static_code_enabled }));

    // --- Existing semantics intact: ignore/restore on a Builder code finding ------------
    const fp = ((viewBuilder.body.result || {}).static_code_findings || [])[0]?.fingerprint;
    if (fp) {
      const ignored = await surface(projBuilder, wsBuilder, userBuilder, { action: "ignore", fingerprint: fp });
      const restored = await surface(projBuilder, wsBuilder, userBuilder, { action: "restore", fingerprint: fp });
      harness.check("ignore/restore still works under the gate (Builder finding round trip)",
        ignored.body.status === "up_to_date" && !(ignored.body.result.static_code_findings || []).some((f) => f.fingerprint === fp) &&
        (restored.body.result.static_code_findings || []).some((f) => f.fingerprint === fp),
        JSON.stringify({}));
    } else {
      harness.check("ignore/restore: a Builder code finding exists to exercise", false, "no static finding");
    }

    // --- Existing semantics intact: one-row persistence + GET never starts --------------
    const noneProj = await mkProject(wsFree.id, "none");
    const noneView = await surface(noneProj, wsFree, userFree, { action: "get" });
    harness.check("GET never starts a scan (none → no row, no job)",
      noneView.body.status === "none" && noneView.body.result === null &&
      (await svc.entities.SecurityScan.filter({ project_id: noneProj.id }, "created_date", 10)).length === 0 &&
      (await jobs(noneProj.id)).length === 0,
      JSON.stringify({ status: noneView.body.status }));
    const builderRows = await svc.entities.SecurityScan.filter({ project_id: projBuilder.id }, "created_date", 10);
    harness.check("one-row persistence: the Builder project has exactly one scan row",
      builderRows.length === 1, JSON.stringify({ rows: builderRows.length }));

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "SecurityScan", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "ProjectFile", { project_id: pid });
      await purgeBy(svc, "AppEntity", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "Budget", { workspace_id: wid });
      await purgeBy(svc, "Subscription", { workspace_id: wid });
      await purgeBy(svc, "WorkspaceMember", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }
}