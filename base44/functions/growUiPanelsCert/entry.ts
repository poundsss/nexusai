// Targeted Grow UI panels certification — Outreach, Support and Reporting surfaces, read-only,
// scratch fixtures only. Each panel's CONTRACT is certified through the SAME call the panel
// makes (no backend code, entity or contract is modified). The scratch workspace, seeds,
// projections and purge come from the SHARED helpers (shared/growPanelCertHelpers.ts):
//   1. rendering: every populated row matches the fields the panels display verbatim;
//   2. empty states: a fresh project yields zero rows / all-zero rollup (valid states);
//   3. project isolation: a second project sees NONE of the first project's rows;
//   4. 403 non-member: the project.read gate protecting the project-scoped reads refuses (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { createPanelScratch, seedPanelRows, readPanelProjections, purgePanelScratch } from "../../shared/growPanelCertHelpers.ts";

const SHAPE_SECTIONS = ["lead_gen", "outreach", "social_listening", "aeo", "social_content", "support"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  let ws = null;
  const projects = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: `gup-ghost-${stamp}`, email: "gup-ghost@example.invalid" };

    const scratch = await createPanelScratch(svc, "grow-panels", caller, stamp);
    ws = scratch.ws;
    projects.push(...scratch.projects);
    const { proj, proj2 } = scratch;

    await seedPanelRows(svc, ws, proj, stamp);

    // ---- EMPTY STATES on the untouched second project (an empty loop is a valid state) ----
    const empty = await readPanelProjections(base44, proj2.id);
    h.check("empty states: outreach and support panels render nothing, the report renders all-zero rollup",
      empty.steps.length === 0 && empty.supportMsgs.length === 0
        && SHAPE_SECTIONS.every((k) => empty.rollup?.[k])
        && empty.rollup.lead_gen.prospects === 0 && empty.rollup.outreach.jobs === 0
        && empty.rollup.aeo.mention_rate === null && empty.rollup.social_content.plans === 0
        && empty.rollup.support.messages === 0,
      JSON.stringify({ jobs: empty.steps.length, messages: empty.supportMsgs.length, rollup: empty.rollup }));

    // ---- The populated AEO fixture (unique to this suite) ----
    const probe = await svc.entities.AeoProbe.create({ project_id: proj.id, workspace_id: ws.id, question: `What is the best tool for growth ${stamp}?` });
    await svc.entities.AeoResult.bulkCreate([
      { project_id: proj.id, workspace_id: ws.id, probe_id: probe.id, question: probe.question, run_key: `rk1_${stamp}`, mentioned: true, rank: 1, excerpt: "x", checked_at: new Date().toISOString() },
    ]);

    // ---- 1. RENDERING: outreach panel's projection (the panel's exact client call) ----
    const { steps } = await readPanelProjections(base44, proj.id);
    h.check("outreach panel: the project's steps render with status, step index, subject and attempts verbatim",
      steps.length === 2
        && steps.every((j) => typeof j.status === "string" && "attempts" in j && j.payload?.subject && Number.isInteger(j.payload?.step_index))
        && steps.some((j) => j.status === "succeeded" && j.payload.step_index === 0 && j.payload.subject === "Intro")
        && steps.some((j) => j.status === "pending" && j.payload.step_index === 1 && j.payload.subject === "Follow up"),
      JSON.stringify(steps.map((j) => ({ s: j.status, idx: j.payload?.step_index, subj: j.payload?.subject, att: j.attempts }))));

    // ---- 2. RENDERING: support panel's projection (the panel's exact client call) ----
    const { supportMsgs: msgs } = await readPanelProjections(base44, proj.id);
    h.check("support panel: the history endpoint returns the message the row displays verbatim",
      msgs.length === 1 && msgs[0].status === "succeeded" && msgs[0].subject === "Check-in"
        && msgs[0].attempts === 1 && !!msgs[0].created_at && msgs[0].customer_id === "c2",
      JSON.stringify(msgs));

    // ---- 3. RENDERING: report panel's projection (the full rollup, verbatim) ----
    const { rollup: report } = await readPanelProjections(base44, proj.id);
    h.check("report panel: the rollup carries every section and the populated values the report renders",
      SHAPE_SECTIONS.every((k) => report?.[k])
        && report.lead_gen.prospects === 2 && report.lead_gen.by_stage.Lead === 1 && report.lead_gen.by_stage.Contacted === 1
        && report.outreach.jobs === 2 && report.social_listening.active_terms === 0
        && report.aeo.active_probes === 1 && report.aeo.measurements === 1 && report.aeo.mentions === 1 && report.aeo.mention_rate === 100
        && report.social_content.plans === 1 && report.social_content.plan_posts === 1
        && report.support.messages === 1 && report.support.by_status.succeeded === 1,
      JSON.stringify(report));

    // ---- 4. ISOLATION: the second project's panels see NONE of the first project's rows ----
    const other = await readPanelProjections(base44, proj2.id);
    h.check("isolation: the second project's outreach, support and report see NONE of the first project's rows",
      other.steps.length === 0 && other.supportMsgs.length === 0
        && other.rollup.lead_gen.prospects === 0 && other.rollup.outreach.jobs === 0
        && other.rollup.social_content.plans === 0 && other.rollup.support.messages === 0,
      JSON.stringify({ jobs: other.steps.length, messages: other.supportMsgs.length, rollup: other.rollup }));

    // ---- 5. AUTHORIZATION: the project.read gate protecting the panels' reads refuses a non-member ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's Grow surfaces (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await purgePanelScratch(svc, ws, projects);
  }

  return harnessResponse(h);
}