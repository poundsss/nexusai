// Targeted certification for the DOCUMENTED (Base44) connector-workflow `condition` behavior:
// "Add a top-level condition to skip a dispatch unless a jq expression over the trigger payload
// is truthy." Runs through the REAL contract, engine and dispatch entry point — no stubs.
// Covers the four required cases:
//   1. truthy condition → dispatch;
//   2. falsy condition → no dispatch;
//   3. absent condition → existing behavior unchanged;
//   4. malformed condition → fail closed without breaking workflow processing.
// Additive-only: a sibling connector workflow WITHOUT a condition still dispatches in case 4 to
// prove the engine keeps processing other definitions after a fail-closed one.
//
// Fixture connector is "github": DOCUMENTED (Base44) slack/slackbot connector automations REQUIRE
// trigger conditions (enforced at authoring — covered in slackConnectorEventCert), so an
// absent-condition fixture must ride a connector whose enforcement is unchanged (github).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum,
} from "../../shared/workflowContract.ts";
import { dispatchWorkflowEvent, advanceWorkflowRun } from "../../shared/workflowEngine.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `cond-${Date.now()}`;
  const h = createHarness();
  const created = { workspace: null, projects: [] };
  try {
    const workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    created.workspace = workspace.id;
    const project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-A`, status: "ready", version_count: 0 });
    created.projects.push(project.id);

    // Finalize a connector-trigger workflow whose trigger may carry a `condition` (a jq string
    // over the trigger payload). The condition rides on the existing freeform `trigger` object,
    // so NO schema change is required.
    // Each fixture carries its OWN event name so a dispatch matches exactly one workflow —
    // triggerMatches selects by (connector, event), so a shared event would cross-match siblings
    // and blur the per-case matched counts. The condition semantics are unchanged.
    const finalized = ({ key, name, event, condition = null }) => {
      const trigger = { type: "connector", connector: "github", event };
      if (condition !== null) trigger.condition = condition;
      const def = { name, trigger, steps: [{ id: "s1", type: "complete", message: "ok" }], entry_step: "s1" };
      const v = validateWorkflow(def, { functionNames: [] });
      if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join("; ")}`);
      return svc.entities.WorkflowDefinition.create({
        workflow_key: key, name, version: 1, status: "FINALIZED", finalized: true,
        project_id: project.id, workspace_id: workspace.id,
        trigger: def.trigger, trigger_type: "connector", trigger_event: def.trigger.event,
        steps: def.steps, entry_step: "s1", definition_checksum: workflowChecksum(def),
        contract_version: WORKFLOW_CONTRACT_VERSION, created_at: new Date().toISOString(),
      });
    };

    const dispatch = (key, event, payload) => dispatchWorkflowEvent(base44, {
      project, workspace: { id: workspace.id }, source: "connector", event, entity: "github",
      payload, idempotency_key: `${key}:${TAG}:${JSON.stringify(payload).length}`, actor: "system",
    });

    const runsFor = (key) => svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: key }, "-created_date", 10);

    // --- 1. truthy condition → dispatch ---
    const truthyDef = await finalized({ key: "truthy", name: "Truthy", event: "msg-truthy", condition: `.event == "msg-truthy"` });
    let r = await dispatch("truthy", "msg-truthy", { event: "msg-truthy", text: "hi" });
    h.check("1 truthy condition dispatches",
      r.matched === 1 && (await runsFor("truthy")).length === 1,
      `matched=${r.matched}, runs=${(await runsFor("truthy")).length}`);

    // --- 2. falsy condition → no dispatch ---
    const falsyDef = await finalized({ key: "falsy", name: "Falsy", event: "msg-falsy", condition: `.event == "never-fires"` });
    r = await dispatch("falsy", "msg-falsy", { event: "msg-falsy", text: "hi" });
    h.check("2 falsy condition does not dispatch",
      r.matched === 0 && (await runsFor("falsy")).length === 0,
      `matched=${r.matched}, runs=${(await runsFor("falsy")).length}`);

    // --- 3. absent condition → existing behavior unchanged (dispatches) ---
    const plainDef = await finalized({ key: "plain", name: "Plain", event: "msg-plain" });
    r = await dispatch("plain", "msg-plain", { event: "msg-plain", text: "hi" });
    const plainRuns = await runsFor("plain");
    h.check("3 absent condition dispatches unchanged",
      r.matched === 1 && plainRuns.length === 1 && plainRuns[0].workflow_id === plainDef.id,
      `matched=${r.matched}, runs=${plainRuns.length}`);

    // --- 4. malformed condition → fail closed, but a sibling workflow still dispatches ---
    const badDef = await finalized({ key: "malformed", name: "Malformed", event: "msg-malformed", condition: `.event ==` });
    const sibDef = await finalized({ key: "sibling", name: "Sibling", event: "msg-sibling" });
    r = await dispatch("malformed", "msg-malformed", { event: "msg-malformed", text: "hi" });
    const sibR = await dispatch("sibling", "msg-sibling", { event: "msg-sibling", text: "hi2" });
    const badRuns = await runsFor("malformed");
    const sibRuns = await runsFor("sibling");
    h.check("4a malformed condition fails closed (no dispatch)",
      r.matched === 0 && badRuns.length === 0,
      `matched=${r.matched}, runs=${badRuns.length}`);
    h.check("4b malformed condition does not break the engine (sibling still dispatches)",
      sibR.matched === 1 && sibRuns.length === 1 && sibRuns[0].workflow_id === sibDef.id,
      `sibMatched=${sibR.matched}, sibRuns=${sibRuns.length}`);

    // --- regression: a matched run still completes on the real engine ---
    const advanced = await advanceWorkflowRun(base44, { workflow_run_id: plainRuns[0].id });
    h.check("5 dispatched run completes on the engine", advanced?.status === "COMPLETED", advanced?.status || "no-run");

    const summary = h.summary();
    return Response.json({ ok: summary.ok, passed: summary.passed, failed: summary.failed, failures: summary.failures });
  } catch (e) {
    const { passed, failed, results } = h.summary();
    return Response.json({ ok: false, error: e.message, stack: String(e.stack || "").slice(0, 800), passed, failed, results }, { status: 500 });
  } finally {
    for (const pid of created.projects) {
      for (const name of ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "BackgroundJob", "AuditLog"]) {
        await purgeBy(svc, name, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    if (created.workspace) await cleanupWorkspace(svc, created.workspace, ["WorkspaceMember", "AuditLog", "TraceEvent"]).catch(() => {});
  }
}