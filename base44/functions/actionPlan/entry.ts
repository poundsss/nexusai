// Action Plan (Slice 2) — the member-authorized surface over actionable items DERIVED from
// the persisted MarketingPlan (Slice 1). Setup/credit/auth/persistence semantics of the plan
// itself are UNTOUCHED. Items derive DETERMINISTICALLY from the plan's channels (one item per
// channel, idempotent per plan_id via source_key) — no undocumented AI action-item semantics.
// Item actions: preview/copy (client projection), Mark done / Dismiss / Reopen (persisted,
// audited), Generate posts / Generate more (the documented 10-integration-credit generation
// through the EXISTING hold/settle ledger — posts persist ONLY after the hold succeeded and
// generation delivered). Send to Builder is a CLIENT prefill of the Builder chat draft — the
// user sends it themselves; nothing auto-submits. No analytics/metric tracking, no social
// scheduling, no Launchpad, no Google Ads, no changes to Social Content generation.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { holdIntegrationCredits } from "../../shared/integrationCharges.ts";

export const config = { public: true };

// Documented rate: Generate posts = EXACTLY 10 integration credits per generation.
const POST_CREDITS = 10;
const POST_BATCH = 3;
const MAX_POSTS = 12;
const STATUSES = ["open", "done", "dismissed"];
const PRIORITIES = ["must_have", "medium", "nice_to_have"];
const PRIORITY_LABELS = { must_have: "Must have", medium: "Medium priority", nice_to_have: "Nice to have" };

const clean = (v, max) => String(v || "").trim().slice(0, max);

const publicItem = (i) => ({
  item_id: i.id, project_id: i.project_id, workspace_id: i.workspace_id, plan_id: i.plan_id,
  source: i.source || "channel", source_key: i.source_key || null, order: i.order || 0,
  title: i.title, body: i.body || "", priority: i.priority || null,
  status: i.status || "open", status_updated_at: i.status_updated_at || null,
  status_updated_by: i.status_updated_by || null,
  posts: i.posts || [], posts_generated_at: i.posts_generated_at || null,
  created_at: i.created_at || i.created_date || null,
});

// Deterministic derivation: one actionable item per plan channel, idempotent per plan_id.
// Body carries the channel's tactics plus budget and first-metric context from the SAME plan.
const deriveItems = async (svc, project, workspace, user, plan) => {
  const existing = await svc.entities.ActionPlanItem.filter({ plan_id: plan.plan_id }, "created_date", 200);
  const derived = new Set(existing.map((i) => i.source_key));
  const missing = (plan.channels || [])
    .map((c, idx) => ({ ...c, idx }))
    .filter((c) => c.name && !derived.has(c.name));
  if (!missing.length) return existing;
  const budgetLine = plan.budget_mode === "paid"
    ? `Suggested budget: $${plan.budget_monthly_amount}/mo paid.`
    : "Organic approach — no paid budget.";
  const firstMetric = (plan.metrics || [])[0];
  const metricLine = firstMetric ? `Key metric: ${firstMetric.name} — ${firstMetric.target}.` : "";
  const rows = missing.map((c) => ({
    project_id: project.id, workspace_id: workspace.id, user_id: user.id,
    plan_id: plan.plan_id, source: "channel", source_key: c.name, order: c.idx,
    title: clean(`Launch on ${c.name}`, 200),
    body: clean(`${c.tactics || ""}\nPriority: ${PRIORITY_LABELS[c.priority] || c.priority}. ${budgetLine} ${metricLine}\nGoal: ${plan.goal}. Audience: ${plan.audience}.`, 2000),
    priority: PRIORITIES.includes(c.priority) ? c.priority : null,
    status: "open", status_updated_at: new Date().toISOString(), status_updated_by: user.id,
    posts: [], created_at: new Date().toISOString(),
  }));
  const created = await svc.entities.ActionPlanItem.bulkCreate(rows);
  return [...existing, ...created];
};

// Load a plan item WITH project isolation: an item from another project resolves to not-found.
const loadItem = async (svc, project, item_id) => {
  const item = await svc.entities.ActionPlanItem.get(item_id).catch(() => null);
  if (!item || item.project_id !== project.id)
    throw Object.assign(new Error("Item not found"), { status: 404, code: "ITEM_NOT_FOUND" });
  return item;
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const svc = base44.asServiceRole || base44;

    if (action === "list") {
      const { project } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");
      // Derive against the LATEST persisted plan; a project without a plan has no items.
      const plans = await svc.entities.MarketingPlan.filter({ project_id: project.id }, "-created_date", 1);
      const items = plans.length ? await deriveItems(svc, project, { id: plans[0].workspace_id }, user, publicPlanLike(plans[0])) : [];
      return Response.json({ project_id: project.id, plan_id: plans[0]?.id || null, items: items.map(publicItem) });
    }

    if (action === "update_item") {
      const { project, workspace } = await loadAuthorizedProject(svc, user, body.project_id, "project.write");
      const status = String(body.status || "");
      if (!STATUSES.includes(status))
        return Response.json({ error: "status must be open, done or dismissed", code: "INVALID_STATUS" }, { status: 400 });
      const item = await loadItem(svc, project, body.item_id);
      const now = new Date().toISOString();
      const updated = await svc.entities.ActionPlanItem.update(item.id, {
        status, status_updated_at: now, status_updated_by: user.id,
      });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: `marketing.action.${status}`, resource: "ActionPlanItem", resource_id: item.id,
        metadata: { item_title: clean(item.title, 120), from: item.status, to: status },
      });
      return Response.json({ item: publicItem(updated) });
    }

    if (action === "generate_posts" || action === "generate_more") {
      const { project, workspace } = await loadAuthorizedProject(svc, user, body.project_id, "project.write");
      const item = await loadItem(svc, project, body.item_id);
      const existing = Array.isArray(item.posts) ? item.posts : [];
      if (action === "generate_more" && existing.length >= MAX_POSTS)
        return Response.json({ error: `Post limit reached (${MAX_POSTS} per item)`, code: "POSTS_LIMIT" }, { status: 400 });

      const plan = await svc.entities.MarketingPlan.get(item.plan_id).catch(() => null);
      if (!plan || plan.project_id !== project.id)
        throw Object.assign(new Error("Plan not found"), { status: 404, code: "PLAN_NOT_FOUND" });

      // Fail-closed credit hold BEFORE any generation; posts persist only after settle-worthy delivery.
      const hold = await holdIntegrationCredits(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        credits: POST_CREDITS, key: `action-posts:${crypto.randomUUID()}`,
        reason: "Action plan posts generation (audited slice rate: 10 integration credits)",
      });
      try {
        const llm = await svc.integrations.Core.InvokeLLM({
          prompt:
            `You write social media posts for a software product.\n` +
            `Product goal: ${plan.goal}\nTarget audience: ${plan.audience}\n` +
            `Action item: ${item.title}\nDetails: ${item.body}\n\n` +
            `Write exactly ${POST_BATCH} ready-to-post social posts promoting this action. ` +
            `Each post: a "platform" short label (e.g. X, LinkedIn, Reddit, Instagram) and "copy" — the full post text, specific and concrete, no placeholders.\n` +
            `Return ONLY the JSON object matching the schema.`,
          response_json_schema: {
            type: "object",
            properties: {
              posts: {
                type: "array",
                items: { type: "object", properties: { platform: { type: "string" }, copy: { type: "string" } }, required: ["platform", "copy"] },
              },
            },
            required: ["posts"],
          },
        });
        const posts = (Array.isArray(llm?.posts) ? llm.posts : [])
          .map((p) => ({ platform: clean(p?.platform, 40) || "Generic", copy: clean(p?.copy, 2000) }))
          .filter((p) => p.copy)
          .slice(0, POST_BATCH);
        if (!posts.length)
          throw Object.assign(new Error("Generation returned no usable posts"), { status: 502, code: "POSTS_EMPTY" });
        const now = new Date().toISOString();
        const updated = await svc.entities.ActionPlanItem.update(item.id, {
          posts: [...existing, ...posts].slice(0, MAX_POSTS),
          posts_generated_at: now,
        });
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "marketing.action.posts_generated", resource: "ActionPlanItem", resource_id: item.id,
          metadata: { mode: action, added: posts.length, total: updated.posts.length, title: clean(item.title, 120) },
        });
        await hold.settle(POST_CREDITS, "Action plan posts generation", { operation: action, item_id: item.id });
        return Response.json({ item: publicItem(updated) });
      } catch (e) {
        await hold.fail();
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "marketing.action.posts_failed", resource: "ActionPlanItem", resource_id: item.id,
          metadata: { mode: action, error_code: e.code || "ACTION_POSTS_ERROR", error: String(e?.message || e).slice(0, 200) },
        }).catch(() => {});
        throw e;
      }
    }

    return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
  } catch (e) {
    const status = e.status || 500;
    return Response.json({ error: String(e.message || e), code: e.code || "ACTION_PLAN_ERROR" }, { status });
  }
}

// list needs a plan-shaped object; publicPlan already exists in the marketingPlan endpoint —
// a minimal local projection keeps this slice self-contained without touching Slice 1.
function publicPlanLike(p) {
  return {
    plan_id: p.id, project_id: p.project_id, goal: p.goal, audience: p.audience,
    budget_mode: p.budget_mode || "organic", budget_monthly_amount: p.budget_monthly_amount || 0,
    channels: p.channels || [], metrics: p.metrics || [],
  };
}