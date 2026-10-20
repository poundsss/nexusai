// Marketing Plan (Slice 1) — the member-authorized SETUP + PERSIST surface over the
// documented Base44 Marketing plan sections (docs.base44.com/promoting-your-app/
// creating-a-marketing-plan): channels ranked Must have / Medium priority / Nice to have,
// key metrics with targets, a paid or organic (no paid budget) monthly budget, the overall
// strategy, and OPTIONAL competitor research. Generation rides the EXISTING Core InvokeLLM
// primitive at the audited slice rate of EXACTLY 10 integration credits, through the
// EXISTING hold/settle ledger (shared/integrationCharges.ts) — the plan row is persisted
// only after the hold succeeded and the generation delivered. No action plan, no
// send-to-builder, no generate-posts, no metrics/analytics tracking, no agent chat, no
// external APIs: generation + persistence + project-scoped reads only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { holdIntegrationCredits } from "../../shared/integrationCharges.ts";
import { aggregate } from "../../shared/analyticsQuery.ts";
import { ANALYTICS_LIMITS, boundRange } from "../../shared/analyticsContract.ts";

export const config = { public: true };

// Audited slice rate: exactly 10 integration credits per plan generation.
const PLAN_CREDITS = 10;
const PRIORITIES = ["must_have", "medium", "nice_to_have"];
const MAX_CHANNELS = 8;
const MAX_METRICS = 6;
const MAX_COMPETITORS = 5;
const DAY = 86400000;

const clean = (v, max) => String(v || "").trim().slice(0, max);

// Safe projection: everything the UI shows, nothing internal.
const publicPlan = (p) => ({
  plan_id: p.id,
  project_id: p.project_id,
  workspace_id: p.workspace_id,
  goal: p.goal,
  audience: p.audience,
  include_competitors: !!p.include_competitors,
  budget_mode: p.budget_mode || "organic",
  budget_monthly_amount: p.budget_monthly_amount || 0,
  channels: p.channels || [],
  metrics: p.metrics || [],
  strategy: p.strategy || "",
  competitors: p.competitors || [],
  generated_at: p.generated_at || p.created_date || null,
});

// Normalization: bounded, enum-checked fields — a malformed model answer never reaches storage.
const normalize = (raw, { include_competitors }) => {
  const channels = (Array.isArray(raw?.channels) ? raw.channels : [])
    .map((c) => ({ name: clean(c?.name, 120), priority: PRIORITIES.includes(c?.priority) ? c.priority : null, tactics: clean(c?.tactics, 500) }))
    .filter((c) => c.name && c.priority)
    .slice(0, MAX_CHANNELS);
  const metrics = (Array.isArray(raw?.metrics) ? raw.metrics : [])
    .map((m) => ({ name: clean(m?.name, 120), target: clean(m?.target, 120) }))
    .filter((m) => m.name && m.target)
    .slice(0, MAX_METRICS);
  const strategy = clean(raw?.strategy, 4000);
  const budget_mode = raw?.budget_mode === "paid" ? "paid" : "organic";
  const budget_monthly_amount = budget_mode === "paid" ? Math.max(0, Math.round((Number(raw?.budget_monthly_amount) || 0) * 100) / 100) : 0;
  const competitors = include_competitors
    ? (Array.isArray(raw?.competitors) ? raw.competitors : [])
        .map((c) => ({ name: clean(c?.name, 120), website: clean(c?.website, 200), description: clean(c?.description, 500), market_gap: clean(c?.market_gap, 500) }))
        .filter((c) => c.name)
        .slice(0, MAX_COMPETITORS)
    : [];
  if (!channels.length || !metrics.length || !strategy)
    throw Object.assign(new Error("Generation returned no usable plan"), { status: 502, code: "PLAN_EMPTY" });
  return { channels, metrics, strategy, budget_mode, budget_monthly_amount, competitors };
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const svc = base44.asServiceRole || base44;

    if (action === "get") {
      const { project } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");
      const rows = await svc.entities.MarketingPlan.filter({ project_id: project.id }, "-created_date", 1);
      return Response.json({ project_id: project.id, plan: rows.length ? publicPlan(rows[0]) : null });
    }

    if (action === "setup") {
      const { project, workspace } = await loadAuthorizedProject(svc, user, body.project_id, "project.write");
      const goal = clean(body.goal, 400);
      const audience = clean(body.audience, 400);
      const include_competitors = !!body.include_competitors;
      if (!goal) return Response.json({ error: "goal is required", code: "GOAL_REQUIRED" }, { status: 400 });
      if (!audience) return Response.json({ error: "audience is required", code: "AUDIENCE_REQUIRED" }, { status: 400 });

      // Fail-closed credit hold BEFORE any generation; the plan row persists only after
      // the hold succeeded and the generation delivered.
      const hold = await holdIntegrationCredits(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        credits: PLAN_CREDITS, key: `marketing-plan:${crypto.randomUUID()}`,
        reason: "Marketing plan generation (audited slice rate: 10 integration credits)",
      });
      try {
        const llm = await svc.integrations.Core.InvokeLLM({
          prompt:
            `You are a marketing strategist for a software product.\n` +
            `Launch goal: ${goal}\nTarget audience: ${audience}\n` +
            `Competitor research: ${include_competitors ? "INCLUDE — provide up to 5 realistic named competitors" : "EXCLUDE — return an empty competitors list"}.\n\n` +
            `Produce a marketing plan with these EXACT sections:\n` +
            `1. "channels": 4-8 marketing channels ranked for this product; every channel's "priority" must be exactly one of "must_have", "medium", "nice_to_have"; include a short "tactics" string with concrete suggested tactics for that channel.\n` +
            `2. "metrics": 3-5 key performance metrics to track; each with a "name" and a concrete "target" (a short measurable goal string, e.g. "500 signups in 90 days").\n` +
            `3. "budget_mode": "paid" when a paid monthly budget clearly helps this goal, otherwise "organic" (no paid budget). When "paid", set "budget_monthly_amount" to a realistic USD monthly figure.\n` +
            `4. "strategy": a 2-4 sentence overall strategy tying the channels and metrics together.\n` +
            `5. "competitors": each entry with "name", "website", "description" and the "market_gap" this product fills — ONLY when competitor research was requested, otherwise an empty array.\n` +
            `Return ONLY the JSON object matching the schema.`,
          response_json_schema: {
            type: "object",
            properties: {
              channels: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, priority: { type: "string", enum: PRIORITIES }, tactics: { type: "string" } },
                  required: ["name", "priority"],
                },
              },
              metrics: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, target: { type: "string" } },
                  required: ["name", "target"],
                },
              },
              budget_mode: { type: "string", enum: ["paid", "organic"] },
              budget_monthly_amount: { type: "number" },
              strategy: { type: "string" },
              competitors: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, website: { type: "string" }, description: { type: "string" }, market_gap: { type: "string" } },
                  required: ["name"],
                },
              },
            },
            required: ["channels", "metrics", "budget_mode", "strategy", "competitors"],
          },
        });
        const plan = normalize(llm, { include_competitors });
        // Persisted ONLY here — after the hold succeeded and generation delivered.
        const row = await svc.entities.MarketingPlan.create({
          project_id: project.id, workspace_id: workspace.id, user_id: user.id,
          goal, audience, include_competitors,
          budget_mode: plan.budget_mode, budget_monthly_amount: plan.budget_monthly_amount,
          channels: plan.channels, metrics: plan.metrics, strategy: plan.strategy,
          competitors: plan.competitors, generated_at: new Date().toISOString(),
        });
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "marketing.plan.generated", resource: "Project", resource_id: project.id,
          metadata: { include_competitors, budget_mode: plan.budget_mode, channels: plan.channels.length },
        });
        await hold.settle(PLAN_CREDITS, "Marketing plan generation", { operation: "marketing_plan_setup" });
        return Response.json({ plan: publicPlan(row) });
      } catch (e) {
        await hold.fail();
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "marketing.plan.setup_failed", resource: "Project", resource_id: project.id,
          metadata: { error_code: e.code || "MARKETING_PLAN_ERROR", status: e.status || 500, error: String(e?.message || e).slice(0, 200) },
        }).catch(() => {});
        throw e;
      }
    }

    // Metrics tracking (read-only): current values derived ON DEMAND from the project's
    // EXISTING analytics events through the EXISTING analyticsQuery primitives. Documented
    // windows are 7 (default) and 30 days; the horizon is clamped by the project's own
    // AppAnalyticsConfig retention — never a hard-coded policy. A metric maps to an event
    // only deterministically: its own structured event_name, or exact normalized equality
    // with a RECORDED event name — otherwise it is surfaced as not tracked, never guessed.
    // No metric history is persisted, no new entities, and NO credits are charged for reads.
    if (action === "metrics") {
      const { project } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");
      const rows = await svc.entities.MarketingPlan.filter({ project_id: project.id }, "-created_date", 1);
      if (!rows.length) return Response.json({ project_id: project.id, plan_id: null, horizon_days: null, metrics: [] });
      const plan = rows[0];
      const cfgRows = await svc.entities.AppAnalyticsConfig.filter({ project_id: project.id }, "-created_date", 1).catch(() => []);
      const cfgDays = Number(cfgRows[0]?.retention_days);
      const horizonDays = Number.isFinite(cfgDays) && cfgDays > 0 ? Math.min(cfgDays, ANALYTICS_LIMITS.max_range_days) : ANALYTICS_LIMITS.max_range_days;
      const now = Date.now();
      const nowISO = new Date(now).toISOString();
      const horizon = boundRange({ from: new Date(now - horizonDays * DAY).toISOString(), to: nowISO, max_days: horizonDays });

      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const entries = (plan.metrics || []).slice(0, MAX_METRICS).map((m) => ({
        name: clean(m?.name, 120),
        target: clean(m?.target, 120),
        event_name: clean(m?.event_name, ANALYTICS_LIMITS.event_name_chars) || null,
        metric_type: m?.metric_type === "conversion" ? "conversion" : "count",
        window_days: Number(m?.window_days) === 30 ? 30 : 7,
        target_number: Number.isFinite(Number(m?.target_number)) && Number(m.target_number) > 0 ? Number(m.target_number) : null,
      })).filter((e) => e.name);

      // One bounded horizon aggregate over the recorded events; deterministic name matching.
      const horizonAgg = await aggregate(svc, project, { from: horizon.from, to: horizon.to, top: 500 });
      const horizonCounts = new Map((horizonAgg.top_events || []).map((t) => [t.key, t.count]));

      const out = [];
      for (const entry of entries) {
        let event_name = null;
        let tracked = false;
        if (entry.event_name) {
          // Structured mapping: tracking was deliberately added for this metric — trusted as-is.
          event_name = entry.event_name;
          tracked = (horizonCounts.get(event_name) || 0) > 0;
        } else {
          const hit = [...horizonCounts.keys()].find((k) => norm(k) === norm(entry.name));
          if (hit) { event_name = hit; tracked = true; entry.metric_type = "count"; }
        }
        if (!event_name) {
          out.push({ name: entry.name, target: entry.target, status: "not_tracked" });
          continue;
        }
        const status = tracked ? "measured" : "waiting_first_event";
        let current_value = 0;
        if (tracked) {
          const win = boundRange({ from: new Date(now - entry.window_days * DAY).toISOString(), to: nowISO, max_days: horizonDays });
          const winAgg = await aggregate(svc, project, {
            from: win.from, to: win.to, event_names: [event_name],
            ...(entry.metric_type === "conversion" ? { event_types: ["conversion"] } : {}), top: 10,
          });
          current_value = winAgg.totals?.events ?? 0;
        }
        out.push({
          name: entry.name, target: entry.target, status,
          event_name, metric_type: entry.metric_type, window_days: entry.window_days,
          current_value,
          ...(entry.target_number != null ? { target_number: entry.target_number, progress_pct: Math.min(100, Math.round((current_value / entry.target_number) * 1000) / 10) } : {}),
        });
      }

      return Response.json({ project_id: project.id, plan_id: plan.id, horizon_days: horizonDays, metrics: out });
    }

    return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
  } catch (e) {
    const status = e.status || 500;
    return Response.json({ error: String(e.message || e), code: e.code || "MARKETING_PLAN_ERROR" }, { status });
  }
}