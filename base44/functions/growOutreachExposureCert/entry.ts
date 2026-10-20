// Targeted Grow Chat COLD-EMAIL exposure certification — closes the cold-emailing gap: the
// EXISTING certified `outreach.ts` execution path exposed to the GrowthAgent through the
// EXISTING tool_configs contract (function_<name> grant, executed through the existing
// function runtime). Scratch fixtures only; NO new outreach architecture, the certified
// shared/outreach.ts module, its job-handler registry entry and its persistence semantics
// are used VERBATIM. ZERO real email: the cert never runs the worker and never injects a
// send seam — scheduled steps stay queued in BackgroundJob.
//   1. exposure: the REAL GrowthAgent document (bundled VERBATIM from
//      shared/growthAgentExposure.json) declares the outreach function tool with a bounded
//      description and its existing grants untouched;
//   2. invocation: the existing read (outreach list) returns the surface's real response;
//   3. validation: unknown actions and every missing/invalid input refuse with the module's
//      verbatim codes (UNKNOWN_ACTION, CUSTOMER_REQUIRED, CUSTOMER_NOT_FOUND, EMAIL_REQUIRED,
//      EMAIL_INVALID, SELF_SEND, CONTENT_REQUIRED, TOO_MANY_FOLLOW_UPS);
//   4. fail-closed + no real email: a valid schedule enqueues ONE pending job and NOTHING is
//      sent — zero succeeded jobs, zero CRM Activity rows, the contact's stage untouched;
//   5. idempotency: re-scheduling the same step is a queue dedup (duplicate:true), not a
//      second job;
//   6. authorization: the project-scoped gate refuses a non-member (403);
//   7. isolation: another project's contact refuses CUSTOMER_NOT_FOUND and the second
//      project's list stays empty.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import growthAgentDoc from "../../shared/growthAgentExposure.json" with { type: "json" };

const EXPECTED_ENTITY_GRANTS = ["Activity", "AeoProbe", "AeoResult", "Customer", "ListenObservation", "ListenTerm"];
const EXPECTED_FN_GRANTS = ["aeo", "emailDomain", "googleAds", "leadGen", "listen", "outreach", "projectDomains", "seoScan", "support", "virality"];

async function callOutreach(project_id, body) {
  try {
    const res = await base44Ref.functions.invoke("outreach", { project_id, ...body });
    return { status: 200, code: null, data: res.data };
  } catch (e) {
    const resp = e?.response;
    return { status: Number(resp?.status || e?.status || 0), code: resp?.data?.code || e?.code || null, data: resp?.data || null };
  }
}
let base44Ref = null;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  base44Ref = base44;
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const workspaceIds = [];
  const projectIds = [];
  const customerIds = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: `grow-outreach-ghost-${stamp}`, email: `grow-outreach-ghost-${stamp}@example.invalid` };

    // ---- 1. EXPOSURE: the real document, parsed exactly as the runtime's contract ----
    const toolConfigs = Array.isArray(growthAgentDoc.tool_configs) ? growthAgentDoc.tool_configs : [];
    const outreachTool = toolConfigs.find((tc) => tc && tc.function_name === "outreach");
    h.check("exposure: the GrowthAgent declares the outreach function tool with a bounded description",
      !!outreachTool && typeof outreachTool.description === "string" && outreachTool.description.length > 0 && outreachTool.description.length <= 2000,
      JSON.stringify({ found: !!outreachTool, desc_len: outreachTool?.description?.length || 0 }));
    const entityGrants = toolConfigs.filter((tc) => tc && tc.entity_name).map((tc) => tc.entity_name).sort();
    const fnGrants = toolConfigs.filter((tc) => tc && tc.function_name).map((tc) => tc.function_name).sort();
    h.check("exposure: the agent's existing Grow grants are untouched (outreach + emailDomain added, nothing removed)",
      JSON.stringify(entityGrants) === JSON.stringify(EXPECTED_ENTITY_GRANTS)
        && JSON.stringify(fnGrants) === JSON.stringify(EXPECTED_FN_GRANTS),
      JSON.stringify({ entityGrants, fnGrants }));

    // ---- scratch fixtures ----
    const ws = await svc.entities.Workspace.create({ name: `grow-outreach-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    workspaceIds.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-outreach-${stamp}`, status: "ready", version_count: 2 });
    projectIds.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-outreach-2-${stamp}`, status: "ready", version_count: 0 });
    projectIds.push(proj2.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `grow-outreach-f-${stamp}`, owner_id: ghost.id, credits_balance: 0, status: "active" });
    workspaceIds.push(foreignWs.id);
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: `grow-outreach-f-${stamp}`, status: "ready", version_count: 0 });
    projectIds.push(foreignProj.id);

    const mkCustomer = async (projectId, over = {}) => {
      const c = await svc.entities.Customer.create({ project_id: projectId, workspace_id: ws.id, status: "Lead", name: "Cert Contact", ...over });
      customerIds.push(c.id);
      return c;
    };
    const custValid = await mkCustomer(proj.id, { email: `outreach-valid-${stamp}@example.invalid` });
    const custNoEmail = await mkCustomer(proj.id, { email: "" });
    const custBadEmail = await mkCustomer(proj.id, { email: "not-an-email" });
    const custSelf = await mkCustomer(proj.id, { email: caller.email });
    const custOtherProject = await mkCustomer(proj2.id, { email: `outreach-other-${stamp}@example.invalid` });

    // ---- 2. EXISTING SURFACE INVOCATION (the exact call the agent tool makes) ----
    const list = await callOutreach(proj.id, { action: "list" });
    h.check("invocation: the existing outreach list read returns the surface's real response (empty history)",
      list.status === 200 && list.data?.count === 0 && Array.isArray(list.data?.jobs) && list.data.jobs.length === 0,
      JSON.stringify(list.data || {}));

    // ---- 3. VALIDATION: the module's verbatim refusal codes, BEFORE anything is scheduled ----
    const unknown = await callOutreach(proj.id, { action: "read" });
    h.check("validation: an unknown action refuses with the surface's verbatim UNKNOWN_ACTION",
      unknown.status === 400 && unknown.code === "UNKNOWN_ACTION", JSON.stringify(unknown));

    const noCustomer = await callOutreach(proj.id, { action: "schedule", subject: "s", body: "b" });
    h.check("validation: schedule without customer_id refuses with the module's verbatim CUSTOMER_REQUIRED",
      noCustomer.status === 400 && noCustomer.code === "CUSTOMER_REQUIRED", JSON.stringify(noCustomer));

    const missingCustomer = await callOutreach(proj.id, { action: "schedule", customer_id: "missing", subject: "s", body: "b" });
    h.check("validation: schedule for an unknown contact refuses with the module's verbatim CUSTOMER_NOT_FOUND (404)",
      missingCustomer.status === 404 && missingCustomer.code === "CUSTOMER_NOT_FOUND", JSON.stringify(missingCustomer));

    const emailRequired = await callOutreach(proj.id, { action: "schedule", customer_id: custNoEmail.id, subject: "s", body: "b" });
    h.check("validation: schedule to a contact with no address refuses with the module's verbatim EMAIL_REQUIRED",
      emailRequired.status === 400 && emailRequired.code === "EMAIL_REQUIRED", JSON.stringify(emailRequired));

    const emailInvalid = await callOutreach(proj.id, { action: "schedule", customer_id: custBadEmail.id, subject: "s", body: "b" });
    h.check("validation: schedule to an invalid address refuses with the module's verbatim EMAIL_INVALID",
      emailInvalid.status === 400 && emailInvalid.code === "EMAIL_INVALID", JSON.stringify(emailInvalid));

    const selfSend = await callOutreach(proj.id, { action: "schedule", customer_id: custSelf.id, subject: "s", body: "b" });
    h.check("validation: schedule to the operator's own address refuses with the module's verbatim SELF_SEND",
      selfSend.status === 400 && selfSend.code === "SELF_SEND", JSON.stringify(selfSend));

    const contentRequired = await callOutreach(proj.id, { action: "schedule", customer_id: custValid.id, subject: "", body: "hello" });
    h.check("validation: schedule with no subject refuses with the module's verbatim CONTENT_REQUIRED",
      contentRequired.status === 400 && contentRequired.code === "CONTENT_REQUIRED", JSON.stringify(contentRequired));

    const tooMany = await callOutreach(proj.id, {
      action: "schedule", customer_id: custValid.id, subject: "s", body: "b",
      follow_ups: [{ subject: "a", body: "b" }, { subject: "c", body: "d" }, { subject: "e", body: "f" }, { subject: "g", body: "h" }],
    });
    h.check("validation: more than 3 follow-ups refuses with the module's verbatim TOO_MANY_FOLLOW_UPS (422)",
      tooMany.status === 422 && tooMany.code === "TOO_MANY_FOLLOW_UPS", JSON.stringify(tooMany));

    // ---- 4. FAIL-CLOSED + NO REAL EMAIL: a valid schedule only ENQUEUES a pending job ----
    const scheduled = await callOutreach(proj.id, { action: "schedule", customer_id: custValid.id, subject: "Hello", body: "Cold email body" });
    h.check("invocation: a valid schedule returns the module's real response (one step, not a duplicate)",
      scheduled.status === 200 && Array.isArray(scheduled.data?.steps) && scheduled.data.steps.length === 1
        && scheduled.data.steps[0].duplicate === false && scheduled.data.steps[0].job_id,
      JSON.stringify(scheduled.data || {}));

    const jobs = (await svc.entities.BackgroundJob.filter({ project_id: proj.id, job_type: "grow.outreach_email" }, "-created_date", 10)) || [];
    const activities = (await svc.entities.Activity.filter({ customerId: custValid.id }, "-created_date", 10)) || [];
    const customerAfter = await svc.entities.Customer.get(custValid.id);
    h.check("fail-closed / no real email: exactly ONE pending job enqueued, ZERO succeeded jobs, zero Activity rows, the contact's stage untouched",
      jobs.length === 1 && jobs[0].status !== "succeeded" && jobs[0].status === "pending"
        && activities.length === 0 && (customerAfter.status || "") === "Lead",
      JSON.stringify({ job_status: jobs[0]?.status, job_count: jobs.length, activities: activities.length, stage: customerAfter.status }));

    // ---- 5. IDEMPOTENCY: a re-schedule is a queue dedup, not a second job ----
    const rescheduled = await callOutreach(proj.id, { action: "schedule", customer_id: custValid.id, subject: "Hello", body: "Cold email body" });
    const jobsAfter = (await svc.entities.BackgroundJob.filter({ project_id: proj.id, job_type: "grow.outreach_email" }, "-created_date", 10)) || [];
    h.check("idempotency: re-scheduling the same sequence marks the step duplicate and does NOT create a second job",
      rescheduled.status === 200 && rescheduled.data?.steps?.[0]?.duplicate === true && jobsAfter.length === 1,
      JSON.stringify({ duplicate: rescheduled.data?.steps?.[0]?.duplicate, job_count: jobsAfter.length }));

    // ---- 6. AUTHORIZATION: the project-scoped gate refuses a non-member ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot reach the project's outreach surface (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));

    // ---- 7. ISOLATION: another project's contact and list ----
    const crossSchedule = await callOutreach(proj.id, { action: "schedule", customer_id: custOtherProject.id, subject: "s", body: "b" });
    h.check("isolation: a contact from another project refuses with the module's verbatim CUSTOMER_NOT_FOUND",
      crossSchedule.status === 404 && crossSchedule.code === "CUSTOMER_NOT_FOUND", JSON.stringify(crossSchedule));
    const list2 = await callOutreach(proj2.id, { action: "list" });
    h.check("project isolation: the second project's outreach list is empty",
      list2.status === 200 && list2.data?.count === 0, JSON.stringify(list2.data || {}));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projectIds) {
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "Activity", { customerId: { $in: customerIds } });
      await purgeBy(svc, "Customer", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaceIds) {
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}