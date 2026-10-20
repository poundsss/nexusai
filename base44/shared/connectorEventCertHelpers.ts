// Shared helpers for connector-event certification harnesses.
//
// Extracted so every platform-managed connector-event cert (Teams, SharePoint, and future ones)
// shares ONE definition of "list the runs a dispatch produced" and "finalize a connector-trigger
// workflow fixture", instead of each suite re-implementing them. The Gmail cert predates this
// module and is a certified path left untouched by design; new certs delegate here.
import { WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum } from "./workflowContract.ts";

/**
 * List the workflow runs a connector dispatch produced for one workflow key, newest first.
 */
export function runsForWorkflow(svc, projectId, key, limit = 20) {
  return svc.entities.WorkflowRun.filter({ project_id: projectId, workflow_key: key }, "-created_date", limit);
}

/**
 * Finalize a connector-trigger workflow fixture (type=connector, single event, jq condition) for a
 * cert scratch project. Validates the definition against the workflow contract before persisting.
 */
export function finalizeConnectorWorkflow(svc, { project, workspace, key, name, connector, event, condition, stepMessage = "ok" }) {
  // DOCUMENTED (Base44): slack/slackbot connector automations REQUIRE trigger conditions — the
  // contract enforces it at authoring, so a cert fixture without an explicit condition carries a
  // permissive always-true one (dispatch behavior unchanged). Other connectors may omit it.
  const effCondition = condition ?? (connector === "slack" || connector === "slackbot" ? "true" : undefined);
  const def = {
    name,
    trigger: { type: "connector", connector, event, ...(effCondition !== undefined ? { condition: effCondition } : {}) },
    steps: [{ id: "fetch", type: "complete", message: stepMessage }],
    entry_step: "fetch",
  };
  const v = validateWorkflow(def, { functionNames: [] });
  if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join("; ")}`);
  return svc.entities.WorkflowDefinition.create({
    workflow_key: key, name: def.name, version: 1, status: "FINALIZED", finalized: true,
    project_id: project.id, workspace_id: workspace.id,
    trigger: def.trigger, trigger_type: "connector", trigger_event: event,
    steps: def.steps, entry_step: "fetch", definition_checksum: workflowChecksum(def),
    contract_version: WORKFLOW_CONTRACT_VERSION, created_at: new Date().toISOString(),
  });
}