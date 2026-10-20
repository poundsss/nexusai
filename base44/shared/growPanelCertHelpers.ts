// Shared scratch fixtures + projections for the Grow panel certification suites
// (growUiPanelsCert, growPanelsReachabilityCert). Scratch-only: every row is created inside
// a throwaway workspace and purged in the finally block. The seeds ARE the populated data
// the mounted panels render verbatim.
import { purgeBy } from "./testHarness.ts";

export async function createPanelScratch(svc, prefix, caller, stamp) {
  const ws = await svc.entities.Workspace.create({ name: `${prefix}-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
  const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `${prefix}-${stamp}`, status: "ready", version_count: 1 });
  const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `${prefix}-2-${stamp}`, status: "ready", version_count: 1 });
  return { ws, proj, proj2, projects: [proj.id, proj2.id] };
}

export async function seedPanelRows(svc, ws, proj, stamp) {
  await svc.entities.Customer.bulkCreate([
    { project_id: proj.id, workspace_id: ws.id, name: "A", email: `a${stamp}@example.com`, status: "Lead" },
    { project_id: proj.id, workspace_id: ws.id, name: "B", email: `b${stamp}@example.com`, status: "Contacted" },
  ]);
  await svc.entities.BackgroundJob.bulkCreate([
    { queue: "default", job_type: "grow.outreach_email", status: "succeeded", attempts: 1, max_attempts: 3, payload: { project_id: proj.id, customer_id: "c1", step_index: 0, subject: "Intro", body: "hi" }, workspace_id: ws.id, project_id: proj.id, idempotency_key: `o1_${stamp}`, available_at: new Date().toISOString() },
    { queue: "default", job_type: "grow.outreach_email", status: "pending", payload: { project_id: proj.id, customer_id: "c1", step_index: 1, subject: "Follow up", body: "hi again" }, workspace_id: ws.id, project_id: proj.id, idempotency_key: `o2_${stamp}`, available_at: new Date().toISOString() },
    { queue: "default", job_type: "grow.support_email", status: "succeeded", attempts: 1, payload: { project_id: proj.id, customer_id: "c2", subject: "Check-in", body: "hello" }, workspace_id: ws.id, project_id: proj.id, idempotency_key: `s1_${stamp}`, available_at: new Date().toISOString() },
  ]);
  const plan = await svc.entities.ViralityPlan.create({ project_id: proj.id, workspace_id: ws.id, plan_id: `cp_${stamp}` });
  await svc.entities.ViralityPlanPost.create({ project_id: proj.id, workspace_id: ws.id, plan_id: plan.plan_id, post_id: `sp_${stamp}`, platform: "linkedin", content: "b" });
  await svc.entities.ViralityScheduledPost.create({
    project_id: proj.id, workspace_id: ws.id, platform: "linkedin", body: "calendar row", status: "scheduled",
    scheduled_at: new Date().toISOString(), title: "Reachability fixture",
  });
  return plan;
}

// The exact read calls the mounted panels make, in one place: the outreach job rows, the
// support history endpoint, the `grow` rollup and the project's calendar rows.
export async function readPanelProjections(base44, pid) {
  const steps = (await base44.entities.BackgroundJob.filter({ project_id: pid, job_type: "grow.outreach_email" }, { sort: "-created_date", limit: 50 })).items ?? [];
  const supportMsgs = (await base44.functions.invoke("support", { project_id: pid, action: "history" })).data?.messages ?? [];
  const rollup = (await base44.functions.invoke("grow", { project_id: pid })).data;
  const calendar = (await base44.entities.ViralityScheduledPost.filter({ project_id: pid }, { sort: "scheduled_at", limit: 50 })).items ?? [];
  return { steps, supportMsgs, rollup, calendar };
}

export async function purgePanelScratch(svc, ws, projects) {
  for (const pid of projects) {
    for (const entity of ["Customer", "BackgroundJob", "ViralityPlan", "ViralityPlanPost", "ViralityScheduledPost", "AeoProbe", "AeoResult", "ListenTerm", "ListenObservation", "AuditLog"]) {
      await purgeBy(svc, entity, { project_id: pid });
    }
    await svc.entities.Project.delete(pid).catch(() => {});
  }
  if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
}