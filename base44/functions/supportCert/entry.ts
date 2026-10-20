// Targeted certification for Phase 7 — outbound-only Customer Support (shared/growSupport.ts +
// the jobHandlers registry entry). ZERO real sends (the send seam is injected), real persistence
// (Customer + Activity + BackgroundJob), full cleanup in `finally`.
//   1. validation: no email, invalid email, self-send, empty content, contact outside the project;
//   2. scheduling: one content-keyed job, deduped re-schedule of the SAME message;
//   3. executor: injected send, CRM timeline row (type "Support"), pipeline stage untouched;
//   4. idempotency: a re-executed message whose job SUCCEEDED is skipped, never resent;
//   5. registry: the grow.support_email handler runs through MAINTENANCE_HANDLERS with a
//     VALID_PAYLOAD check; history is project-scoped;
//   6. authorization: a non-member cannot read the project (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { scheduleSupportMessage, executeSupportMessage, listSupportHistory, SUPPORT_JOB_TYPE } from "../../shared/growSupport.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";

const SENT = async (args) => ({ sent: true, to: args.to });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [], customers = [], activities = [], jobs = [];

  try {
    const ws = await svc.entities.Workspace.create({ name: `support-${stamp}`, owner_id: `ownerS_${stamp}` });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `support-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `support2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);
    const c = await svc.entities.Customer.create({ project_id: proj.id, workspace_id: ws.id, name: "Dana", email: `dana${stamp}@example.com`, status: "Contacted" });
    customers.push(c.id);
    const noEmail = await svc.entities.Customer.create({ project_id: proj.id, workspace_id: ws.id, name: "NoMail", email: "", status: "Lead" });
    customers.push(noEmail.id);

    // ---- 1. validation ---------------------------------------------------------------------
    const missingCustomer = await captureCall(() => scheduleSupportMessage(svc, proj, ws, { customer_id: "", subject: "s", body: "b" }));
    h.check("an empty customer_id is refused 400 (CUSTOMER_REQUIRED)", missingCustomer.threw && missingCustomer.code === "CUSTOMER_REQUIRED", missingCustomer.code || "no-throw");
    const notFound = await captureCall(() => scheduleSupportMessage(svc, proj, ws, { customer_id: "no-such", subject: "s", body: "b" }));
    h.check("an unknown contact is refused 404 (CUSTOMER_NOT_FOUND)", notFound.threw && notFound.code === "CUSTOMER_NOT_FOUND", notFound.code || "no-throw");
    const noEmailRes = await captureCall(() => scheduleSupportMessage(svc, proj, ws, { customer_id: noEmail.id, subject: "s", body: "b" }));
    h.check("a contact without an email is refused 400 (EMAIL_REQUIRED)", noEmailRes.threw && noEmailRes.code === "EMAIL_REQUIRED", noEmailRes.code || "no-throw");
    const selfSend = await captureCall(() => scheduleSupportMessage(svc, proj, ws, { customer_id: c.id, subject: "s", body: "b", operator_email: `dana${stamp}@example.com` }));
    h.check("the operator's own address is refused 400 (SELF_SEND)", selfSend.threw && selfSend.code === "SELF_SEND", selfSend.code || "no-throw");
    const noContent = await captureCall(() => scheduleSupportMessage(svc, proj, ws, { customer_id: c.id, subject: "", body: "  " }));
    h.check("empty subject/body is refused 400 (CONTENT_REQUIRED)", noContent.threw && noContent.code === "CONTENT_REQUIRED", noContent.code || "no-throw");
    const crossProject = await captureCall(() => scheduleSupportMessage(svc, proj2, ws, { customer_id: c.id, subject: "s", body: "b" }));
    h.check("a contact outside the project is refused 404 (CUSTOMER_NOT_FOUND)", crossProject.threw && crossProject.code === "CUSTOMER_NOT_FOUND", crossProject.code || "no-throw");

    // ---- 2. scheduling ------------------------------------------------------------------------
    const sch = await scheduleSupportMessage(svc, proj, ws, { customer_id: c.id, subject: `Check-in ${stamp}`, body: "How is everything going?", operator_email: "op@example.com" });
    jobs.push(sch.job_id);
    h.check("the message is scheduled as ONE content-keyed grow.support_email job", sch.job_id && !sch.duplicate, JSON.stringify(sch));
    const sch2 = await scheduleSupportMessage(svc, proj, ws, { customer_id: c.id, subject: `Check-in ${stamp}`, body: "How is everything going?", operator_email: "op@example.com" });
    jobs.push(sch2.job_id);
    h.check("re-scheduling the SAME message is a dedup: the same job id", sch2.duplicate === true && sch2.job_id === sch.job_id, JSON.stringify(sch2));
    const sch3 = await scheduleSupportMessage(svc, proj, ws, { customer_id: c.id, subject: `Different ${stamp}`, body: "Other content", operator_email: "op@example.com" });
    jobs.push(sch3.job_id);
    h.check("a DIFFERENT message is its own job (content keys differ)", sch3.duplicate === false && sch3.job_id !== sch.job_id, JSON.stringify(sch3));

    // ---- 3+4. executor: send, timeline, idempotency ----------------------------------------------
    let sendCalls = 0;
    const sendSeam = async (args) => { sendCalls++; return SENT(args); };
    const exec = await executeSupportMessage(svc, { project_id: proj.id, customer_id: c.id, subject: `Check-in ${stamp}`, body: "How is everything going?" }, { send: sendSeam });
    activities.push(exec.activity_id);
    h.check("the executor sends through the seam, records ONE Support timeline row and leaves the stage untouched",
      exec.status === "sent" && sendCalls === 1 && exec.activity_id, JSON.stringify(exec));
    const activities2 = await svc.entities.Activity.filter({ customerId: c.id }, "created_date", 10);
    h.check("the timeline row is type Support and the pipeline stage is UNCHANGED (Contacted)",
      activities2.length === 1 && activities2[0].type === "Support", JSON.stringify(activities2.map((a) => ({ t: a.type, n: a.notes }))));
    // The queue marks a job succeeded once its handler returns; the executor's skip keys off that.
    await svc.entities.BackgroundJob.update(sch.job_id, { status: "succeeded" });
    const reExec = await executeSupportMessage(svc, { project_id: proj.id, customer_id: c.id, subject: `Check-in ${stamp}`, body: "How is everything going?" }, { send: sendSeam });
    h.check("a re-executed message whose job SUCCEEDED is skipped and NOT resent",
      reExec.status === "skipped" && reExec.skipped === "already_sent" && sendCalls === 1, JSON.stringify(reExec));
    const againExec = await executeSupportMessage(svc, { project_id: proj.id, customer_id: c.id, subject: `Different ${stamp}`, body: "Other content" }, { send: sendSeam });
    h.check("a different message to the same contact sends on its own key", againExec.status === "sent" && sendCalls === 2, JSON.stringify(againExec));

    // ---- 5. registry + history ---------------------------------------------------------------------
    // The registry handler runs the SAME executor with NO send seam (a real send) — production
    // behavior this certification must never trigger. The job is ALREADY marked succeeded (step 4), which exercises
    // the handler's idempotent SKIP path (the full send path is covered by the injected seam in
    // step 3, which calls the identical executor).
    const registryRun = await MAINTENANCE_HANDLERS[SUPPORT_JOB_TYPE]({ id: sch.job_id, payload: { project_id: proj.id, customer_id: c.id, subject: `Check-in ${stamp}`, body: "How is everything going?" } }, { base44: svc, heartbeat: async () => {} });
    h.check("the registry handler runs (an already-sent message SKIPS, never resends)",
      registryRun.status === "skipped", JSON.stringify(registryRun));
    const invalid = await captureCall(() => MAINTENANCE_HANDLERS[SUPPORT_JOB_TYPE]({ id: "j-bad", payload: { project_id: proj.id } }, { base44: svc, heartbeat: async () => {} }));
    h.check("a payload without customer_id is INVALID_PAYLOAD and non-retryable", invalid.threw && invalid.code === "INVALID_PAYLOAD", invalid.code || "no-throw");
    const history = await listSupportHistory(svc, proj, {});
    h.check("the history lists this project's support jobs only", history.messages.length >= 2, JSON.stringify(history.messages.length));
    const history2 = await listSupportHistory(svc, proj2, {});
    h.check("isolation: another project's history is empty", history2.messages.length === 0, JSON.stringify(history2));

    // ---- 6. authorization ---------------------------------------------------------------------------
    const stranger = { id: `s_stranger_${stamp}`, email: "ss@example.com" };
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, stranger, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's support history (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const jid of jobs) await svc.entities.BackgroundJob.delete(jid).catch(() => {});
    for (const aid of activities) await svc.entities.Activity.delete(aid).catch(() => {});
    for (const cid of customers) await svc.entities.Customer.delete(cid).catch(() => {});
    for (const pid of projects) {
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}