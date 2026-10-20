// The NexusAI Workflow / Automation API (#28).
//
// Public: the credential-free contract description. Everything else is authenticated and
// re-authorized against the workflow's OWN project inside the shared module — this endpoint never
// trusts a client-supplied project, workspace or ownership claim.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createWorkflow, updateWorkflow, validateWorkflowDefinition, finalizeWorkflow,
  listWorkflows, getWorkflow, triggerWorkflow, dispatchEvent,
  getWorkflowRun, listWorkflowRuns, cancelWorkflowRun, retryWorkflowRun, advanceRun,
  describeWorkflowContract,
} from "../../shared/workflowApi.ts";

export const config = { public: true };

const ACTIONS = {
  create: createWorkflow,
  update: updateWorkflow,
  validate: validateWorkflowDefinition,
  finalize: finalizeWorkflow,
  list: listWorkflows,
  get: getWorkflow,
  trigger: triggerWorkflow,
  dispatch: dispatchEvent,
  run: getWorkflowRun,
  runs: listWorkflowRuns,
  cancel: cancelWorkflowRun,
  retry: retryWorkflowRun,
  advance: advanceRun,
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const url = new URL(req.url);

  // The contract itself carries no project state, so it is readable without authentication.
  if (req.method === "GET" || url.searchParams.get("action") === "capabilities") {
    return Response.json(describeWorkflowContract());
  }

  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const handler = ACTIONS[action];
    if (!handler) return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION", actions: Object.keys(ACTIONS) }, { status: 400 });
    return Response.json(await handler(base44, user, body));
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || "WORKFLOW_ERROR", ...(e.details ? { details: e.details } : {}) }, { status: e.status || 500 });
  }
}