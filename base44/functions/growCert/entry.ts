// Targeted certification for Phase 8 — the FINAL Grow integration (shared/growStatus.ts + the
// grow surface). Real persistence across every certified capability's entity, full cleanup.
//   1. aggregation: one project's rollup covers lead gen, listening, AEO, content and support;
//   2. mention rate is computed from stored results; the empty state degrades to zeros, not errors;
//   3. isolation: a second project's rollup sees NONE of the first project's rows;
//   4. authorization: a non-member cannot read the rollup (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { buildGrowStatus } from "../../shared/growStatus.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    const ws = await svc.entities.Workspace.create({ name: `grow-${stamp}`, owner_id: `ownerG_${stamp}` });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);

    // Seed one project with rows from EVERY certified capability.
    await svc.entities.Customer.bulkCreate([
      { project_id: proj.id, workspace_id: ws.id, name: "A", email: `a${stamp}@example.com`, status: "Lead" },
      { project_id: proj.id, workspace_id: ws.id, name: "B", email: `b${stamp}@example.com`, status: "Contacted" },
      { project_id: proj.id, workspace_id: ws.id, name: "C", email: `c${stamp}@example.com`, status: "Contacted" },
      { project_id: proj2.id, workspace_id: ws.id, name: "Other", email: `o${stamp}@example.com`, status: "Lead" },
    ]);
    const term = await svc.entities.ListenTerm.create({ project_id: proj.id, workspace_id: ws.id, label: "Acme", kind: "company", terms: ["acme launch"] });
    await svc.entities.ListenObservation.create({ project_id: proj.id, workspace_id: ws.id, term_id: term.id, term_label: "Acme", source: "tavily", title: "t", url: "", snippet: "s", dedup_key: `k_${stamp}`, observed_at: new Date().toISOString() });
    const probe = await svc.entities.AeoProbe.create({ project_id: proj.id, workspace_id: ws.id, question: `What is the best tool for deploy ${stamp}?` });
    await svc.entities.AeoResult.bulkCreate([
      { project_id: proj.id, workspace_id: ws.id, probe_id: probe.id, question: probe.question, run_key: `rk1_${stamp}`, mentioned: true, rank: 2, excerpt: "x", checked_at: new Date().toISOString() },
      { project_id: proj.id, workspace_id: ws.id, probe_id: probe.id, question: probe.question, run_key: `rk2_${stamp}`, mentioned: false, excerpt: "x", checked_at: new Date().toISOString() },
    ]);
    await svc.entities.BackgroundJob.bulkCreate([
      { queue: "default", job_type: "grow.support_email", status: "succeeded", payload: { project_id: proj.id }, workspace_id: ws.id, project_id: proj.id, idempotency_key: `s1_${stamp}`, available_at: new Date().toISOString() },
      { queue: "default", job_type: "grow.outreach_email", status: "pending", payload: { project_id: proj.id }, workspace_id: ws.id, project_id: proj.id, idempotency_key: `s2_${stamp}`, available_at: new Date().toISOString() },
    ]);

    // ---- 1+2. aggregation -------------------------------------------------------------------------
    const status = await buildGrowStatus(svc, proj);
    h.check("lead gen: 3 prospects with the stage breakdown", status.lead_gen.prospects === 3 && status.lead_gen.by_stage.Lead === 1 && status.lead_gen.by_stage.Contacted === 2, JSON.stringify(status.lead_gen));
    h.check("listening: 1 active term and 1 observation", status.social_listening.active_terms === 1 && status.social_listening.observations === 1, JSON.stringify(status.social_listening));
    h.check("aeo: 1 active probe, 2 measurements, 1 mention, 50% mention rate", status.aeo.active_probes === 1 && status.aeo.measurements === 2 && status.aeo.mentions === 1 && status.aeo.mention_rate === 50, JSON.stringify(status.aeo));
    h.check("outreach: the scheduled cold-email job is counted", status.outreach.jobs === 1, JSON.stringify(status.outreach));
    h.check("support: 1 outbound message recorded as succeeded", status.support.messages === 1 && status.support.by_status.succeeded === 1, JSON.stringify(status.support));

    // ---- 3. isolation -------------------------------------------------------------------------------
    const empty = await buildGrowStatus(svc, proj2);
    // proj2 owns exactly ONE seeded prospect (its own "Other" row) and nothing else — any second
    // stage or any listening/AEO/support row would be leakage from the first project.
    h.check("isolation: the second project's rollup sees ONLY its own row, none of the first project's",
      empty.lead_gen.prospects === 1 && empty.lead_gen.by_stage.Lead === 1 && Object.keys(empty.lead_gen.by_stage).length === 1
      && empty.social_listening.active_terms === 0 && empty.social_listening.observations === 0
      && empty.aeo.measurements === 0 && empty.support.messages === 0 && empty.outreach.jobs === 0,
      JSON.stringify({ prospects: empty.lead_gen.prospects, stages: empty.lead_gen.by_stage, terms: empty.social_listening.active_terms, aeo: empty.aeo.measurements, support: empty.support.messages }));

    // ---- 4. authorization ----------------------------------------------------------------------------
    const stranger = { id: `s_stranger_${stamp}`, email: "sg@example.com" };
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, stranger, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's growth rollup (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "Customer", { project_id: pid });
      await purgeBy(svc, "ListenTerm", { project_id: pid });
      await purgeBy(svc, "ListenObservation", { project_id: pid });
      await purgeBy(svc, "AeoProbe", { project_id: pid });
      await purgeBy(svc, "AeoResult", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}