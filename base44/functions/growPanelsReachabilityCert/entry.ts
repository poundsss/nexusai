// Grow panels REACHABILITY certification — read-only, scratch fixtures only.
// The six read-only panels (Overview, Report, Optimize, Outreach, Support, Company) and the
// publishing Calendar are mounted through the Grow view switcher in the real UI entry point
// (src/pages/GrowthAgent.jsx). A backend suite cannot render React, so this cert proves the
// REACHABLE side of each mount: every panel's exact runtime contract, exercised through the
// SAME call the mounted panel makes, for the project a member can select (scratch workspace,
// seeds, projections and purge come from the SHARED helpers in shared/growPanelCertHelpers.ts):
//   Overview/Report — the member-authorized `grow` rollup (shape + populated + isolation);
//   Outreach        — the project's `grow.outreach_email` BackgroundJob rows;
//   Support         — the member-authorized `support` endpoint, action=history;
//   Optimize        — the member-authorized `managedAds` recommend_list (read-only list);
//   Company         — the member-authorized `myBusiness` company_get + status (blocker as data);
//   Calendar        — the project's ViralityScheduledPost rows (project-scoped; no query param
//                     anywhere in the contract — the ?tiktok dialog remains a preserved extra).
// Plus: project isolation for every mounted read, and the shared project.read gate refusing a
// non-member (403). No backend code, entity or contract is modified.
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
    const ghost = { id: `gpr-ghost-${stamp}`, email: "gpr-ghost@example.invalid" };

    const scratch = await createPanelScratch(svc, "grow-reach", caller, stamp);
    ws = scratch.ws;
    projects.push(...scratch.projects);
    const { proj, proj2 } = scratch;

    await seedPanelRows(svc, ws, proj, stamp);

    // ---- 1. Overview / Report panels: the rollup they render, shape + populated values ----
    const { rollup } = await readPanelProjections(base44, proj.id);
    h.check("overview and report panels: the grow rollup exposes every section and the populated values they render",
      SHAPE_SECTIONS.every((k) => rollup?.[k])
        && rollup.lead_gen.prospects === 2 && rollup.lead_gen.by_stage.Lead === 1 && rollup.lead_gen.by_stage.Contacted === 1
        && rollup.outreach.jobs === 2 && rollup.social_content.plans === 1 && rollup.social_content.plan_posts === 1
        && rollup.support.messages === 1 && rollup.support.by_status.succeeded === 1
        && "mention_rate" in rollup.aeo && "active_terms" in rollup.social_listening,
      JSON.stringify(rollup));

    // ---- 2. Outreach panel: the project's outreach job rows with the fields it displays ----
    h.check("outreach panel: the project's steps render status, step index, subject and attempts verbatim",
      rollup.outreach.jobs === 2 && (await readPanelProjections(base44, proj.id)).steps.every(
        (j) => typeof j.status === "string" && "attempts" in j && Number.isInteger(j.payload?.step_index) && !!j.payload?.subject),
      JSON.stringify(rollup.outreach));

    // ---- 3. Support panel: the member-authorized history endpoint the panel calls ----
    const { supportMsgs: msgs } = await readPanelProjections(base44, proj.id);
    h.check("support panel: the history endpoint returns the message the row displays verbatim",
      msgs.length === 1 && msgs[0].status === "succeeded" && msgs[0].subject === "Check-in" && !!msgs[0].created_at,
      JSON.stringify(msgs));

    // ---- 4. Optimize panel: the read-only recommend_list call the panel makes ----
    const recs = (await base44.functions.invoke("managedAds", { action: "recommend_list", project_id: proj.id, channel: "google" })).data;
    h.check("optimize panel: recommend_list answers the panel with a recommendations list (empty until a report exists — no error)",
      Array.isArray(recs?.recommendations),
      JSON.stringify(recs || null));

    // ---- 5. Company panel: company_get + the GBP blocker as data, exactly what it renders ----
    const company = (await base44.functions.invoke("myBusiness", { action: "company_get", project_id: proj.id })).data;
    const mbStatus = (await base44.functions.invoke("myBusiness", { action: "status", project_id: proj.id })).data;
    h.check("company panel: company monitoring answers as data and the My Business status carries the certified blocker",
      company && Array.isArray(company.observations ?? [])
        && typeof mbStatus?.blocker === "string" && mbStatus.blocker.length > 0 && !!mbStatus?.code,
      JSON.stringify({ company, status: mbStatus }));

    // ---- 6. Calendar panel: the project's scheduled-post rows, reachable with NO query param ----
    const { calendar } = await readPanelProjections(base44, proj.id);
    h.check("calendar panel: the project's calendar rows render platform, body, status and scheduled instant verbatim — no query parameter anywhere in this contract",
      calendar.length === 1 && calendar[0].platform === "linkedin" && calendar[0].body === "calendar row"
        && calendar[0].status === "scheduled" && !!calendar[0].scheduled_at && !!calendar[0].title,
      JSON.stringify(calendar));

    // ---- 7. ISOLATION: the second project's mounted panels see NONE of the first project's rows ----
    const other = await readPanelProjections(base44, proj2.id);
    h.check("isolation: the second project's overview, outreach, support and calendar see NONE of the first project's rows",
      other.steps.length === 0 && other.supportMsgs.length === 0 && other.calendar.length === 0
        && other.rollup.lead_gen.prospects === 0 && other.rollup.outreach.jobs === 0
        && other.rollup.social_content.plans === 0 && other.rollup.support.messages === 0,
      JSON.stringify({ jobs: other.steps.length, messages: other.supportMsgs.length, calendar: other.calendar.length }));

    // ---- 8. AUTHORIZATION: the shared project.read gate refusing a non-member (403) ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read any mounted panel's project-scoped surface (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await purgePanelScratch(svc, ws, projects);
  }

  return harnessResponse(h);
}