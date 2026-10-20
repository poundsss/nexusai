// Targeted Grow Overview UI certification — read-only, scratch fixtures only.
// The Overview surface (src/components/growthagent/GrowOverview.jsx) is a pure projection of
// the certified `grow` rollup; this suite certifies the CONTRACT it renders against, through
// the SAME client-side call the surface makes (base44.functions.invoke("grow", ...)):
//   1. the rollup shape the six cards render (every section and field verbatim),
//   2. an empty loop degrades to all zeros (the surface's empty state), not errors,
//   3. a populated loop's numbers match what the cards display,
//   4. project isolation: a second project's rollup sees ONLY its own rows,
//   5. authorization: a non-member is refused (403) — the surface's unauthorized state.
// No backend code, entity or contract is modified.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

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
    const ghost = { id: `goui-ghost-${stamp}`, email: "goui-ghost@example.invalid" };

    ws = await svc.entities.Workspace.create({ name: `grow-overview-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-overview-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-overview-2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);

    // ---- 1. the rollup SHAPE the Overview renders (the empty state is also the shape check) ----
    const fresh = (await base44.functions.invoke("grow", { project_id: proj.id })).data;
    h.check("the grow rollup exposes every section the six Overview cards render",
      SHAPE_SECTIONS.every((k) => fresh && fresh[k] && typeof fresh[k] === "object"),
      JSON.stringify({ sections: SHAPE_SECTIONS.filter((k) => !fresh?.[k]) }));
    h.check("every field the cards display is present verbatim",
      Array.isArray(fresh.lead_gen.by_stage) === false && typeof fresh.lead_gen.by_stage === "object"
        && typeof fresh.outreach.jobs === "number"
        && "active_terms" in fresh.social_listening && "observations" in fresh.social_listening && "latest_observation_at" in fresh.social_listening
        && "active_probes" in fresh.aeo && "measurements" in fresh.aeo && "mentions" in fresh.aeo && "mention_rate" in fresh.aeo
        && "plans" in fresh.social_content && "plan_posts" in fresh.social_content
        && typeof fresh.support.by_status === "object",
      JSON.stringify(fresh || {}));

    // ---- 2. the empty state: an untouched project degrades to all zeros, not errors ----
    h.check("an empty loop renders the empty state: every count is zero and mention_rate is null",
      fresh.lead_gen.prospects === 0 && fresh.outreach.jobs === 0 && fresh.social_listening.active_terms === 0
        && fresh.social_listening.observations === 0 && fresh.aeo.active_probes === 0 && fresh.aeo.measurements === 0
        && fresh.aeo.mention_rate === null && fresh.social_content.plans === 0 && fresh.social_content.plan_posts === 0
        && fresh.support.messages === 0,
      JSON.stringify(fresh));

    // ---- 3. the populated loop's numbers match what the cards display ----
    await svc.entities.Customer.bulkCreate([
      { project_id: proj.id, workspace_id: ws.id, name: "A", email: `a${stamp}@example.com`, status: "Lead" },
      { project_id: proj.id, workspace_id: ws.id, name: "B", email: `b${stamp}@example.com`, status: "Contacted" },
      { project_id: proj.id, workspace_id: ws.id, name: "C", email: `c${stamp}@example.com`, status: "Contacted" },
    ]);
    const term = await svc.entities.ListenTerm.create({ project_id: proj.id, workspace_id: ws.id, label: "Acme", kind: "company", terms: ["acme launch"] });
    await svc.entities.ListenObservation.create({ project_id: proj.id, workspace_id: ws.id, term_id: term.id, term_label: "Acme", source: "tavily", title: "t", url: "", snippet: "s", dedup_key: `k_${stamp}`, observed_at: new Date().toISOString() });
    const probe = await svc.entities.AeoProbe.create({ project_id: proj.id, workspace_id: ws.id, question: `What is the best tool for growth ${stamp}?` });
    await svc.entities.AeoResult.bulkCreate([
      { project_id: proj.id, workspace_id: ws.id, probe_id: probe.id, question: probe.question, run_key: `rk1_${stamp}`, mentioned: true, rank: 2, excerpt: "x", checked_at: new Date().toISOString() },
      { project_id: proj.id, workspace_id: ws.id, probe_id: probe.id, question: probe.question, run_key: `rk2_${stamp}`, mentioned: false, excerpt: "x", checked_at: new Date().toISOString() },
    ]);
    await svc.entities.BackgroundJob.bulkCreate([
      { queue: "default", job_type: "grow.support_email", status: "succeeded", payload: { project_id: proj.id }, workspace_id: ws.id, project_id: proj.id, idempotency_key: `s1_${stamp}`, available_at: new Date().toISOString() },
      { queue: "default", job_type: "grow.outreach_email", status: "pending", payload: { project_id: proj.id }, workspace_id: ws.id, project_id: proj.id, idempotency_key: `s2_${stamp}`, available_at: new Date().toISOString() },
    ]);
    const plan = await svc.entities.ViralityPlan.create({ project_id: proj.id, workspace_id: ws.id, plan_id: `cp_${stamp}` });
    await svc.entities.ViralityPlanPost.create({ project_id: proj.id, workspace_id: ws.id, plan_id: `cp_${stamp}`, post_id: `sp_${stamp}`, platform: "linkedin", content: "b" });

    const status = (await base44.functions.invoke("grow", { project_id: proj.id })).data;
    h.check("the populated loop matches the card values exactly",
      status.lead_gen.prospects === 3 && status.lead_gen.by_stage.Lead === 1 && status.lead_gen.by_stage.Contacted === 2
        && status.outreach.jobs === 1
        && status.social_listening.active_terms === 1 && status.social_listening.observations === 1 && !!status.social_listening.latest_observation_at
        && status.aeo.active_probes === 1 && status.aeo.measurements === 2 && status.aeo.mentions === 1 && status.aeo.mention_rate === 50
        && status.social_content.plans === 1 && status.social_content.plan_posts === 1
        && status.support.messages === 1 && status.support.by_status.succeeded === 1,
      JSON.stringify(status));

    // ---- 4. project isolation: the second project's rollup sees ONLY its own rows ----
    const other = (await base44.functions.invoke("grow", { project_id: proj2.id })).data;
    h.check("isolation: the second project's overview sees NONE of the first project's rows",
      other.lead_gen.prospects === 0 && other.outreach.jobs === 0 && other.social_listening.active_terms === 0
        && other.social_listening.observations === 0 && other.aeo.measurements === 0
        && other.social_content.plans === 0 && other.social_content.plan_posts === 0 && other.support.messages === 0,
      JSON.stringify(other));

    // ---- 5. authorization: a non-member is refused (403) — the unauthorized state ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's growth overview (403)",
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
      await purgeBy(svc, "ViralityPlan", { project_id: pid });
      await purgeBy(svc, "ViralityPlanPost", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
  }

  return harnessResponse(h);
}