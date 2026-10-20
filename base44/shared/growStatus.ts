// Runable Grow — Phase 8: the FINAL Grow integration. One project-scoped rollup over every
// certified growth capability, so the loop can be observed (and driven) from a single surface:
//   • Lead Gen        — prospects in the pipeline, by stage
//   • Cold Email      — scheduled outreach jobs, by status (jobs are project-scoped rows)
//   • Social Listening — active terms, observations collected
//   • AEO             — active probes, measurements, mention rate
//   • Social Content  — virality plans and planned posts
//   • Support         — outbound support messages, by status
// Aggregation ONLY: it reads, never mutates, and every read is filtered by the authorized
// project's id — one project's loop can never appear in another's report. Individual counts
// degrade to 0 when a capability has nothing yet (an empty loop is a valid state, not an error).
export async function buildGrowStatus(svc, project) {
  const id = project.id;
  const count = async (entity, query) => { try { return (await svc.entities[entity].filter(query, "created_date", 500)).length; } catch { return 0; } };
  const sample = async (entity, query) => { try { return (await svc.entities[entity].filter(query, "-created_date", 1))[0] || null; } catch { return null; } };

  const customers = (await svc.entities.Customer.filter({ project_id: id }, "created_date", 500).catch(() => [])) || [];
  const stages = {};
  for (const c of customers) stages[c.status] = (stages[c.status] || 0) + 1;

  const terms = (await svc.entities.ListenTerm.filter({ project_id: id, status: "active" }, "created_date", 100).catch(() => [])) || [];
  const latestObservation = await sample("ListenObservation", { project_id: id });

  const probes = (await svc.entities.AeoProbe.filter({ project_id: id, status: "active" }, "created_date", 100).catch(() => [])) || [];
  const aeoResults = (await svc.entities.AeoResult.filter({ project_id: id }, "created_date", 500).catch(() => [])) || [];
  const mentioned = aeoResults.filter((r) => r.mentioned === true).length;

  const supportJobs = (await svc.entities.BackgroundJob.filter({ project_id: id, job_type: "grow.support_email" }, "created_date", 500).catch(() => [])) || [];
  const supportStatuses = {};
  for (const j of supportJobs) supportStatuses[j.status] = (supportStatuses[j.status] || 0) + 1;

  const plans = await count("ViralityPlan", { project_id: id });
  const planPosts = await count("ViralityPlanPost", { project_id: id });

  return {
    project_id: id,
    workspace_id: project.workspace_id || null,
    lead_gen: { prospects: customers.length, by_stage: stages },
    outreach: { jobs: await count("BackgroundJob", { project_id: id, job_type: "grow.outreach_email" }) },
    social_listening: {
      active_terms: terms.length,
      observations: await count("ListenObservation", { project_id: id }),
      latest_observation_at: latestObservation?.observed_at || null,
    },
    aeo: {
      active_probes: probes.length,
      measurements: aeoResults.length,
      mentions: mentioned,
      mention_rate: aeoResults.length ? Math.round((mentioned / aeoResults.length) * 100) : null,
    },
    social_content: { plans, plan_posts: planPosts },
    support: { messages: supportJobs.length, by_status: supportStatuses },
  };
}