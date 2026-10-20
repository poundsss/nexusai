// Base44 Virality Engine — Phase 1 (pinned by the DOCUMENTED contract:
// docs.base44.com/developers/references/apps-api/sections/virality + /api-reference/*).
//
// Scope of this slice, exactly the documented surface:
//   • persisted flow state (one ViralityState row per project) with the COMPUTED stage
//     surface idle | questions | strategy | generating | completed — the stage is never
//     stored verbatim, it is derived from the row + the current plan;
//   • start → questions → submit-answers → strategy → generate → completed;
//   • refine-strategy (rewrites the strategy and DISCARDS the existing plan, every post
//     and every generated image — the documented warning);
//   • plan generation: 1..3 platforms of x|instagram|tiktok|linkedin|reddit|facebook,
//     unsupported values ignored, none supported → 400; one language-model call per
//     platform + the FIRST platform's images inline, remaining images in the background
//     through the EXISTING job queue (poll the state to pick image_url values up);
//   • credits: generate = 10 (fail-closed INSUFFICIENT_CREDITS before the work), single-post
//     refine = 1, post image = 1 — the plan price covers the plan's own images;
//   • manual post content update with the documented sanitization (XML/HTML tags, code
//     fences and lines starting system:/assistant:/user: removed); no model, no credits;
//   • single-post refine with the documented 409 while a refinement of the SAME post is
//     in flight; the surviving version is the request's own edit — here the in-flight
//     refine is refused outright until it settles or goes stale;
//   • reset clears everything; a reset never refunds credits already spent.
//
// NOT in this slice (deliberate): the social calendar, scheduling/publishing jobs, the
// Instagram/Facebook connectors, teaser, post analytics. The teaser contract is UNKNOWN
// (its endpoint is not published) — the state body reports teaser: null. Rate-limit pools
// (15/20/40 rpm per app) are platform infrastructure this runtime does not own (UNKNOWN).
//
// UNKNOWN in Base44's contract, marked rather than invented:
//   • posts per platform (the docs' example shows total_posts 5; bounded here at 5);
//   • whether submit-answers also discards an old plan (only refine-strategy is documented
//     to discard it, so the plan survives submit-answers here);
//   • the builder_handle extraction rule (only "taken from the social_url" is documented);
//   • whether a failed generate keeps the previous plan (docs are silent — here it does);
//   • fence sanitization granularity ("code fences ... are removed" — here the fence
//     markers are removed and the fenced text kept).

import { audit } from "./authz.ts";
import { holdIntegrationCredits } from "./integrationCharges.ts";
import { enqueue } from "./jobQueue.ts";
import { log } from "./observability.ts";

export const VIRALITY_IMAGE_JOB_TYPE = "virality.image";
export const PLATFORMS = ["x", "instagram", "tiktok", "linkedin", "reddit", "facebook"];
// instagram/linkedin/facebook are the documented Phase 2 set; x is the NEXUSAI-DERIVED
// addition on the metered X connector's documented text-post contract (its connection is
// checked through the proxy, never getConnection). TikTok remains OUT of the unconditional
// allowlist: socialCalendar enables it per post only after OWN OAuth scope/capability checks.
// Base44's shared TikTok read/list connector is never used or modified for publishing.
export const PUBLISHABLE_PLATFORMS = ["instagram", "linkedin", "facebook", "x"];
export const POST_ANGLES = ["pain_point", "feature_demo", "social_proof", "trending_hook", "user_story", "before_after"];
export const CONTENT_MODES = ["series", "selection"];
export const MAX_PLATFORMS = 3; // documented maxItems: 3
export const MAX_POSTS_PER_PLATFORM = 5; // NEXUSAI bound (UNKNOWN; documented example shows 5)
export const PLAN_CREDITS = 10;
export const REFINE_POST_CREDITS = 1;
export const POST_IMAGE_CREDITS = 1;

const GENERATING_STALE_MS = 15 * 60 * 1000; // a plan generation that died is healed by the next call
const REFINE_STALE_MS = 5 * 60 * 1000;      // an in-flight refine marker older than this no longer blocks
const POST_FETCH_LIMIT = 200;

const nowIso = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

export const err = (message, status, code) => Object.assign(new Error(message), { status, code });

// The documented sanitization of manually updated post content: XML and HTML tags, code
// fences, and lines starting system:/assistant:/user: are removed.
export function sanitizeContent(raw) {
  let text = String(raw ?? "");
  text = text.replace(/^\s*```.*$/gm, " "); // code fences (markers removed, content kept)
  text = text.replace(/<[^>\n]*>/g, " ");   // XML and HTML tags
  text = text
    .split("\n")
    .filter((line) => !/^\s*(system|assistant|user)\s*:/i.test(line))
    .join("\n");
  return text.trim();
}

function builderHandleFromUrl(url) {
  // NEXUSAI-DERIVED (UNKNOWN): the docs say the handle is "taken from the social_url" without
  // an algorithm. The last path segment (or the host) is prefixed with @, as most social URLs do.
  const raw = String(url || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : u.hostname;
    return last.startsWith("@") ? last.slice(0, 64) : `@${String(last).slice(0, 63)}`;
  } catch {
    return null;
  }
}

// --- state, plan and post row helpers ------------------------------------------------

const newestRow = async (svc, name, filter) => (await svc.entities[name].filter(filter, "-created_date", 1))[0] || null;
export const getStateRow = (svc, projectId) => newestRow(svc, "ViralityState", { project_id: projectId });
export const getCurrentPlan = (svc, projectId) => newestRow(svc, "ViralityPlan", { project_id: projectId });

// The documented plan ids are UUIDs (examples show UUID v4 shapes) and the post_id is
// validated "is a UUID" — both are minted as UUIDs here.
const uuid = () => crypto.randomUUID();

const isGenerating = (row) => {
  if (!row || row.generating_action !== "plan" || !row.generating_started_at) return false;
  const age = Date.now() - Date.parse(row.generating_started_at);
  return Number.isFinite(age) && age >= 0 && age < GENERATING_STALE_MS;
};

// Every caller discards the WHOLE project's plan+posts (plan replacement, restart, reset,
// refine-strategy), so the bulk paths are exact: two deleteMany calls instead of a per-row
// walk, which also keeps the operation inside the storage rate budget.
async function deletePlanAndPosts(svc, projectId) {
  await svc.entities.ViralityPlanPost.deleteMany({ project_id: projectId }).catch(() => []);
  await svc.entities.ViralityPlan.deleteMany({ project_id: projectId }).catch(() => []);
}

// --- the generators (injectable for certification; defaults are the REAL Core calls) ---

const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    analysis_text: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          type: { type: "string", enum: ["select", "text_input"] },
          options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] } },
          placeholder: { type: "string" },
        },
        required: ["id", "question", "type"],
      },
    },
  },
  required: ["analysis_text", "questions"],
};

const PLATFORM_POSTS_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: CONTENT_MODES },
    reasoning: { type: "string" },
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          angle: { type: "string", enum: POST_ANGLES },
          angle_label: { type: "string" },
          suggested_day: { type: "number" },
          rationale: { type: "string" },
          content: { type: "string" },
          image_prompt: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          post_title: { type: "string" },
          suggested_subreddits: { type: "array", items: { type: "string" } },
          launch_comment: { type: "string" },
          option_label: { type: "string" },
          best_for_context: { type: "string" },
          best_time_reason: { type: "string" },
        },
        required: ["content"],
      },
    },
  },
  required: ["posts"],
};

// The default generators — the REAL AI calls through the EXISTING Core integration.
export const REAL_GENERATORS = {
  questions: async (svc, { project }) => {
    const out = await svc.integrations.Core.InvokeLLM({
      prompt:
        `Analyze the app "${project?.name || "this app"}" for social media promotion, the way Base44's ` +
        `social content flow does. Return a one-sentence analysis of what the app does, then 2 or 3 ` +
        `questions whose answers should shape its content strategy. The LAST question must ask for the ` +
        `builder's social profile URL (type text_input, placeholder like https://x.com/yourhandle). ` +
        `A select question offers 2-4 concrete options; a text_input question takes free text. ` +
        `Give each question a short stable id (snake_case).`,
      response_json_schema: QUESTIONS_SCHEMA,
    });
    return {
      analysis_text: clean(out?.analysis_text, 500) || null,
      questions: (out?.questions || []).slice(0, 3).map((q, i) => ({
        id: clean(q?.id, 64) || `q${i + 1}`,
        question: clean(q?.question, 500) || `Question ${i + 1}`,
        type: q?.type === "text_input" ? "text_input" : "select",
        options: Array.isArray(q?.options) && q.options.length
          ? q.options.slice(0, 6).map((o) => ({ label: clean(o?.label, 200), description: o?.description ? clean(o.description, 300) : null }))
          : null,
        placeholder: q?.placeholder ? clean(q.placeholder, 200) : null,
      })),
    };
  },

  strategy: async (svc, { project, answers, social_url, feedback, previous }) => {
    const out = await svc.integrations.Core.InvokeLLM({
      prompt: feedback && previous
        ? `Rewrite this content strategy for promoting the app "${project?.name || "this app"}" according to the feedback. ` +
          `The builder answered: ${JSON.stringify(answers || {})}.` +
          (social_url ? ` Their social profile (voice reference — you cannot browse it): ${social_url}.` : "") +
          `\nCurrent strategy:\n${previous}\n\nFeedback: ${feedback}\n\n` +
          `Return ONLY the rewritten strategy text: the positioning, the angles to lead with and the cadence. No headings, no commentary.`
        : `Write a concise content strategy for promoting the app "${project?.name || "this app"}" on social media. ` +
          `The builder answered: ${JSON.stringify(answers || {})}.` +
          (social_url ? ` Their social profile (voice reference — you cannot browse it): ${social_url}.` : "") +
          `\nReturn ONLY the strategy text itself: the positioning, the angles to lead with and the cadence. No headings, no commentary.`,
    });
    return { strategy_text: clean(typeof out === "string" ? out : out?.strategy_text, 8000) };
  },

  platformPosts: async (svc, { platform, project, strategy_text }) => {
    const out = await svc.integrations.Core.InvokeLLM({
      prompt:
        `Write social posts for ${platform} promoting the app "${project?.name || "this app"}", following this strategy:\n${strategy_text}\n\n` +
        `Decide whether a series (publish in order) or a selection (alternatives to pick one from) fits ${platform} best, and say why in "reasoning". ` +
        `Write up to ${MAX_POSTS_PER_PLATFORM} posts adapted to ${platform}'s tone, format and length conventions. ` +
        `Every post MUST include "content" — the ready-to-publish text itself, no placeholders, no commentary, and hashtags belong in "hashtags" (without #), not in the content. ` +
        `Give each post an editorial "angle" from: ${POST_ANGLES.join(", ")}, a "post_number" (1-based), an "image_prompt" (concrete image-generation prompt, no text/letters in the image) ` +
        `and a "best_time_reason" (why the suggested day/time works for this audience). A Reddit post may carry "suggested_subreddits"; a Reddit/LinkedIn post a "post_title".`,
      response_json_schema: PLATFORM_POSTS_SCHEMA,
    });
    return {
      mode: CONTENT_MODES.includes(out?.mode) ? out.mode : "series",
      reasoning: clean(out?.reasoning, 1000) || null,
      posts: (out?.posts || []).slice(0, MAX_POSTS_PER_PLATFORM).map((p) => ({
        angle: POST_ANGLES.includes(p?.angle) ? p.angle : null,
        angle_label: p?.angle_label ? clean(p.angle_label, 120) : null,
        suggested_day: Number.isFinite(p?.suggested_day) ? p.suggested_day : null,
        rationale: p?.rationale ? clean(p.rationale, 1000) : null,
        content: clean(p?.content, 50000),
        image_prompt: p?.image_prompt ? clean(p.image_prompt, 2000) : null,
        hashtags: Array.isArray(p?.hashtags) ? p.hashtags.slice(0, 30).map((h) => String(h).replace(/^#/, "").slice(0, 100)).filter(Boolean) : [],
        post_title: p?.post_title ? clean(p.post_title, 300) : null,
        suggested_subreddits: Array.isArray(p?.suggested_subreddits) ? p.suggested_subreddits.slice(0, 10).map((s) => clean(s, 100)).filter(Boolean) : [],
        launch_comment: p?.launch_comment ? clean(p.launch_comment, 2000) : null,
        option_label: p?.option_label ? clean(p.option_label, 200) : null,
        best_for_context: p?.best_for_context ? clean(p.best_for_context, 500) : null,
        best_time_reason: p?.best_time_reason ? clean(p.best_time_reason, 1000) : null,
      })).filter((p) => p.content),
    };
  },

  image: async (svc, { prompt }) => {
    const img = await svc.integrations.Core.GenerateImage({ prompt });
    return img?.url || null;
  },
};

// --- projections (the documented response shapes) ------------------------------------

const projectPost = (p) => ({
  id: p.post_id,
  platform: p.platform,
  angle: p.angle || null,
  angle_label: p.angle_label || null,
  post_number: p.post_number ?? null,
  total_posts: p.total_posts ?? null,
  suggested_day: p.suggested_day ?? null,
  rationale: p.rationale || null,
  content: p.content || "",
  image_url: p.image_url || null,
  image_prompt: p.image_prompt || null,
  hashtags: p.hashtags || [],
  post_title: p.post_title || null,
  suggested_subreddits: p.suggested_subreddits || [],
  launch_comment: p.launch_comment || null,
  option_label: p.option_label || null,
  best_for_context: p.best_for_context || null,
  best_time_reason: p.best_time_reason || null,
  cover_index: Math.max(0, (p.post_number || 1) - 1), // documented: 0-based position in the platform's series
  image_status: p.image_status || "none", // NEXUSAI-native: how far the image generation got
  image_error: p.image_error || null,
});

async function projectPlan(svc, project, planRow) {
  if (!planRow) return null;
  const posts = await svc.entities.ViralityPlanPost.filter({ project_id: project.id, plan_id: planRow.plan_id }, "created_date", POST_FETCH_LIMIT).catch(() => []);
  const platforms = (planRow.platform_plan || []).map((pp) => ({
    platform: pp.platform || null,
    mode: pp.mode || null,
    reasoning: pp.reasoning || null,
    posts: posts
      .filter((p) => p.platform === pp.platform)
      .map(projectPost)
      .sort((a, b) => (a.post_number || 0) - (b.post_number || 0)),
  }));
  return {
    id: planRow.plan_id,
    app_id: project.id,
    strategy: {
      app_summary: planRow.app_summary || null,
      marketing_approach: planRow.marketing_approach || null,
      platforms,
    },
    created_at: planRow.created_at || null,
    updated_at: planRow.updated_at || null,
  };
}

/** The COMPUTED stage surface (never stored verbatim). */
export function stageOf(row, plan) {
  if (isGenerating(row)) return "generating";
  if (plan) return "completed";
  if (row?.strategy_text) return "strategy";
  if (row?.questions?.length) return "questions";
  return "idle";
}

async function stateBody(svc, project, row, plan) {
  return {
    stage: stageOf(row, plan),
    questions: row?.questions?.length ? row.questions : null,
    analysis_text: row?.analysis_text || null,
    answers: row?.answers && Object.keys(row.answers).length ? row.answers : null,
    strategy_text: row?.strategy_text || null,
    plan: await projectPlan(svc, project, plan),
    builder_handle: row?.social_url ? builderHandleFromUrl(row.social_url) : null,
    app_name: project.name || null,
    teaser: null, // the teaser contract is UNKNOWN (endpoint unpublished) — reported as null, never invented
  };
}

async function requireStateRow(svc, projectId) {
  const row = await getStateRow(svc, projectId);
  if (!row) throw err("The app has no social content state yet", 404, "NO_STATE");
  // A dead generation marker is healed (cleared) by the next state/generate call — the
  // documented healing path, so a crashed generation never wedges the flow.
  if (row.generating_action && !isGenerating(row)) {
    return await svc.entities.ViralityState.update(row.id, { generating_action: null, generating_started_at: null }).catch(() => row);
  }
  return row;
}

async function guardNotGenerating(row) {
  if (isGenerating(row)) throw err("A content plan is currently generating", 409, "PLAN_GENERATING");
}

// --- the surface ----------------------------------------------------------------------

export async function viralitySurface(svc, project, workspace, user, input, { generators = {} } = {}) {
  const gen = { ...REAL_GENERATORS, ...(generators || {}) };
  const action = String(input.action || "state");
  let row0 = await getStateRow(svc, project.id);
  // The read-only state surface still heals a dead generation marker (documented).
  if (row0 && row0.generating_action && !isGenerating(row0)) {
    row0 = await svc.entities.ViralityState.update(row0.id, { generating_action: null, generating_started_at: null }).catch(() => row0);
  }

  if (action === "state") {
    // GET parity: the read-only status surface — it NEVER starts anything.
    return stateBody(svc, project, row0, await getCurrentPlan(svc, project.id));
  }

  if (action === "start") {
    await guardNotGenerating(row0);
    // The analysis runs FIRST: on failure nothing was discarded (documented 500 → retry).
    const questions = await gen.questions(svc, { project });
    if (!questions.questions?.length) throw err("The app analysis failed", 500, "ANALYSIS_EMPTY");
    // Restart semantics (documented): answers, strategy and content plan are discarded.
    await deletePlanAndPosts(svc, project.id);
    const patch = {
      analysis_text: questions.analysis_text || null,
      questions: questions.questions,
      answers: {},
      social_url: null,
      strategy_text: null,
      generating_action: null,
      generating_started_at: null,
      last_error: null,
    };
    let row = row0;
    if (row) row = await svc.entities.ViralityState.update(row.id, patch);
    else {
      row = await svc.entities.ViralityState.create({ project_id: project.id, workspace_id: workspace.id, ...patch });
      // One-row invariant under a concurrent start: the losers are deleted by id.
      const dups = await svc.entities.ViralityState.filter({ project_id: project.id }, "created_date", 10);
      for (const dup of dups.slice(1)) await svc.entities.ViralityState.delete(dup.id).catch(() => {});
    }
    return { questions: row.questions, analysis_text: row.analysis_text };
  }

  if (action === "submit_answers") {
    const row = await requireStateRow(svc, project.id);
    await guardNotGenerating(row);
    if (!row.questions?.length) throw err("The app has no questions to answer", 409, "NO_QUESTIONS");
    const known = new Set(row.questions.map((q) => q.id));
    const answers = {};
    for (const [k, v] of Object.entries(input.answers || {})) {
      if (known.has(k) && String(v ?? "").trim()) answers[k] = clean(v, 400);
    }
    if (!Object.keys(answers).length) throw err("answers must carry at least one answered question", 400, "ANSWERS_REQUIRED");
    const social_url = input.social_url ? clean(input.social_url, 500) : null;
    // The strategy runs first — a failed generation leaves the previous state intact.
    const strategy = await gen.strategy(svc, { project, answers, social_url });
    if (!strategy.strategy_text) throw err("Strategy generation returned no strategy", 502, "STRATEGY_EMPTY");
    // UNKNOWN (docs silent): whether submit-answers discards an old plan — only refine-strategy
    // is documented to, so the plan survives here.
    const updated = await svc.entities.ViralityState.update(row.id, { answers, social_url, strategy_text: strategy.strategy_text });
    return { strategy_text: updated.strategy_text };
  }

  if (action === "refine_strategy") {
    const row = await requireStateRow(svc, project.id);
    await guardNotGenerating(row);
    if (!row.strategy_text) throw err("The app has no strategy to refine", 409, "NO_STRATEGY");
    const feedback = clean(input.feedback ?? input.request, 5000);
    if (!feedback) throw err("feedback is required", 400, "FEEDBACK_REQUIRED");
    const strategy = await gen.strategy(svc, { project, answers: row.answers, social_url: row.social_url, feedback, previous: row.strategy_text });
    if (!strategy.strategy_text) throw err("Strategy refinement returned no strategy", 502, "STRATEGY_EMPTY");
    // Documented warning: refining the strategy discards the existing plan, every post
    // and every generated image — BEFORE the new strategy is stored.
    await deletePlanAndPosts(svc, project.id);
    const updated = await svc.entities.ViralityState.update(row.id, { strategy_text: strategy.strategy_text });
    return { strategy_text: updated.strategy_text };
  }

  if (action === "generate") {
    const row = await requireStateRow(svc, project.id);
    await guardNotGenerating(row);
    if (!row.strategy_text) throw err("The app has no accepted strategy yet", 409, "NO_STRATEGY");
    // Platform validation (documented): 1..3 of the documented pool, unsupported values
    // ignored preserving order, none supported → 400, more than 3 → 422.
    const requested = Array.isArray(input.platforms) ? input.platforms : [];
    const platforms = [...new Set(requested.map((p) => String(p || "").trim().toLowerCase()))].filter((p) => PLATFORMS.includes(p));
    if (!platforms.length) throw err("None of the requested platforms are supported", 400, "NO_SUPPORTED_PLATFORM");
    if (platforms.length > MAX_PLATFORMS) throw err(`At most ${MAX_PLATFORMS} platforms can be generated`, 422, "TOO_MANY_PLATFORMS");

    // Fail-closed credits: the hold is refused BEFORE anything starts (402 INSUFFICIENT_CREDITS).
    const hold = await holdIntegrationCredits(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      credits: PLAN_CREDITS, key: `virality:plan:${uuid()}`,
      reason: "Social content plan generation (Base44 documented typical rate: 10 credits)",
    });
    try {
      await svc.entities.ViralityState.update(row.id, { generating_action: "plan", generating_started_at: nowIso(), last_error: null });
      const plan_id = uuid();
      const social_url = input.social_url ? clean(input.social_url, 500) : row.social_url;
      const platformPlans = await Promise.all(platforms.map((platform) =>
        gen.platformPosts(svc, { platform, project, strategy_text: row.strategy_text, social_url })));
      if (platformPlans.some((pp) => !pp.posts.length)) throw err("Generation returned no usable posts", 502, "GENERATION_EMPTY");

      await deletePlanAndPosts(svc, project.id);
      const created_at = nowIso();
      const planRow = await svc.entities.ViralityPlan.create({
        project_id: project.id, workspace_id: workspace.id, plan_id,
        app_summary: row.analysis_text || null, marketing_approach: row.strategy_text || null,
        platform_plan: platforms.map((platform, i) => ({ platform, mode: platformPlans[i].mode, reasoning: platformPlans[i].reasoning })),
        created_at, updated_at: created_at,
      });

      // Post rows. The FIRST platform's images generate inline; the rest enqueue as
      // background jobs (the documented inline/background split), pollable via the state.
      const postRows = [];
      for (let i = 0; i < platforms.length; i++) {
        const platform = platforms[i];
        const pp = platformPlans[i];
        for (let j = 0; j < pp.posts.length; j++) {
          const p = pp.posts[j];
          postRows.push({
            project_id: project.id, workspace_id: workspace.id, plan_id, post_id: uuid(),
            platform,
            angle: p.angle, angle_label: p.angle_label, post_number: j + 1, total_posts: pp.posts.length,
            suggested_day: p.suggested_day, rationale: p.rationale, content: p.content,
            image_prompt: p.image_prompt, image_url: null,
            image_status: p.image_prompt ? "pending" : "none",
            hashtags: p.hashtags, post_title: p.post_title, suggested_subreddits: p.suggested_subreddits,
            launch_comment: p.launch_comment, option_label: p.option_label, best_for_context: p.best_for_context,
            best_time_reason: p.best_time_reason, refine_started_at: null,
          });
        }
      }
      const createdPosts = await svc.entities.ViralityPlanPost.bulkCreate(postRows);
      const idByPost = new Map((createdPosts || []).map((c) => [c.post_id, c.id]));
      for (const p of postRows) if (idByPost.has(p.post_id)) p.id = idByPost.get(p.post_id); // the DB id, for the inline image updates below

      // Inline images: the first platform only (documented), bounded by its post count.
      let background_image_count = 0;
      for (const p of postRows) {
        const isInline = p.platform === platforms[0] && !!p.image_prompt;
        if (!isInline && p.image_status === "pending") background_image_count++;
      }
      const inline = postRows.filter((p) => p.platform === platforms[0] && p.image_prompt);
      // One bulkUpdate for all inline images — fewer storage calls, same result.
      const inlineResults = await Promise.all(inline.map(async (p) => {
        try {
          const url = await gen.image(svc, { prompt: p.image_prompt });
          return url
            ? { id: p.id, image_url: url, image_status: "ready", image_error: null }
            : { id: p.id, image_status: "failed", image_error: "Image generation returned no image" };
        } catch (e) {
          return { id: p.id, image_status: "failed", image_error: String(e?.message || e).slice(0, 200) };
        }
      }));
      await svc.entities.ViralityPlanPost.bulkUpdate(inlineResults.filter((u) => u.id));
      // Background images: the remaining platforms, one idempotent job per post.
      for (const p of postRows) {
        if (p.platform !== platforms[0] && p.image_status === "pending") {
          await enqueue(svc, {
            queue: "default", job_type: VIRALITY_IMAGE_JOB_TYPE,
            payload: { project_id: project.id, plan_id, post_id: p.post_id },
            max_attempts: 3, idempotency_key: `virality:img:${plan_id}:${p.post_id}`,
            workspace_id: workspace.id, project_id: project.id,
          });
        }
      }

      // The plan's own images ride the plan price (documented "typically ~10 credits" for
      // the plan) — the generation delivered, so the full hold settles.
      await hold.settle(PLAN_CREDITS, "Social content plan generation", { platforms });
      await svc.entities.ViralityState.update(row.id, { generating_action: null, generating_started_at: null });
      log("info", "virality.plan.generated", { project_id: project.id, plan_id, platforms, background_image_count });
      return stateBody(svc, project, { ...row, generating_action: null }, planRow);
    } catch (e) {
      // UNKNOWN (docs silent on a failed generate): the hold is released, the marker is
      // cleared and the PREVIOUS plan is kept — nothing half-generated is persisted.
      await svc.entities.ViralityState.update(row.id, {
        generating_action: null, generating_started_at: null,
        last_error: String(e?.message || e).slice(0, 300),
      }).catch(() => {});
      await hold.fail(); // releases the hold; charges nothing (idempotent by key)
      throw e;
    }
  }

  if (action === "update_post") {
    const row = await requireStateRow(svc, project.id);
    await guardNotGenerating(row);
    const post_id = clean(input.post_id, 100);
    if (!post_id) throw err("post_id is required", 400, "POST_ID_REQUIRED");
    const plan = await getCurrentPlan(svc, project.id);
    if (!plan) throw err("The app has no content plan", 404, "NO_PLAN");
    const posts = await svc.entities.ViralityPlanPost.filter({ project_id: project.id, plan_id: plan.plan_id, post_id }, "created_date", 5).catch(() => []);
    const post = posts[0];
    if (!post) throw err("The post is not in the current plan", 404, "POST_NOT_FOUND");
    if (input.content === undefined || input.content === null || !String(input.content).trim()) {
      throw err("content is required", 400, "CONTENT_REQUIRED");
    }
    // Documented sanitization, then store. Only the content changes — the image and every
    // other post stay as they are. Free: no model call, no credits.
    const content = sanitizeContent(String(input.content)).slice(0, 50000);
    await svc.entities.ViralityPlanPost.update(post.id, { content });
    await svc.entities.ViralityPlan.update(plan.id, { updated_at: nowIso() });
    return { plan: (await stateBody(svc, project, row, plan)).plan };
  }

  if (action === "refine_post") {
    const row = await requireStateRow(svc, project.id);
    await guardNotGenerating(row);
    const post_id = clean(input.post_id, 100);
    const request = clean(input.request, 5000);
    if (!post_id) throw err("post_id is required", 400, "POST_ID_REQUIRED");
    if (!request) throw err("request is required", 400, "REQUEST_REQUIRED");
    const plan = await getCurrentPlan(svc, project.id);
    if (!plan) throw err("The app has no content plan", 404, "NO_PLAN");
    const posts = await svc.entities.ViralityPlanPost.filter({ project_id: project.id, plan_id: plan.plan_id, post_id }, "created_date", 5).catch(() => []);
    const post = posts[0];
    if (!post) throw err("The post is not in the current plan", 404, "POST_NOT_FOUND");
    // Documented in-flight protection: editing the same post while a refinement is in
    // flight is refused with a 409; a marker older than the staleness bound is healed.
    const refineAge = post.refine_started_at ? Date.now() - Date.parse(post.refine_started_at) : Infinity;
    if (Number.isFinite(refineAge) && refineAge >= 0 && refineAge < REFINE_STALE_MS) {
      throw err("A refinement of this post is already in flight", 409, "REFINE_IN_FLIGHT");
    }
    const hold = await holdIntegrationCredits(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      credits: REFINE_POST_CREDITS, key: `virality:refine:${post_id}:${uuid()}`,
      reason: "Refine a post (Base44 documented typical rate: 1 credit)",
    });
    try {
      await svc.entities.ViralityPlanPost.update(post.id, { refine_started_at: nowIso() });
      const rewritten = await gen.refinePost?.(svc, { post: projectPost(post), plan, request })
        ?? (await svc.integrations.Core.InvokeLLM({
          prompt:
            `Rewrite this ${post.platform} post according to the request. Return ONLY the new ready-to-publish ` +
            `text — no placeholders, no commentary, no surrounding quotes. Hashtags belong out of the text.\n\n` +
            `Current post:\n${post.content}\n\nRequest: ${request}`,
        }));
      const content = sanitizeContent(typeof rewritten === "string" ? rewritten : rewritten?.content || "").slice(0, 50000);
      if (!content) throw err("Refinement returned no text", 502, "REFINE_EMPTY");
      await svc.entities.ViralityPlanPost.update(post.id, { content, refine_started_at: null });
      await svc.entities.ViralityPlan.update(plan.id, { updated_at: nowIso() });
      await hold.settle(REFINE_POST_CREDITS, "Refine a post", { operation: "refine_post" });
      return { plan: (await stateBody(svc, project, row, plan)).plan };
    } catch (e) {
      await svc.entities.ViralityPlanPost.update(post.id, { refine_started_at: null }).catch(() => {});
      await hold.fail();
      throw e;
    }
  }

  if (action === "image") {
    const row = await requireStateRow(svc, project.id);
    await guardNotGenerating(row);
    const post_id = clean(input.post_id, 100);
    if (!post_id) throw err("post_id is required", 400, "POST_ID_REQUIRED");
    const plan = await getCurrentPlan(svc, project.id);
    if (!plan) throw err("The app has no content plan", 404, "NO_PLAN");
    const posts = await svc.entities.ViralityPlanPost.filter({ project_id: project.id, plan_id: plan.plan_id, post_id }, "created_date", 5).catch(() => []);
    const post = posts[0];
    if (!post) throw err("The post is not in the current plan", 404, "POST_NOT_FOUND");
    const prompt = post.image_prompt
      || `Clean promotional visual for a ${post.platform} post about ${plan.app_summary || project.name || "an app"}`; // NEXUSAI-DERIVED fallback (UNKNOWN: promptless post)
    const hold = await holdIntegrationCredits(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      credits: POST_IMAGE_CREDITS, key: `virality:image:${post_id}:${uuid()}`,
      reason: "Generate a post image (Base44 documented typical rate: 1 credit)",
    });
    try {
      const url = await gen.image(svc, { prompt, post: projectPost(post) });
      if (!url) throw err("Image generation returned no image", 502, "IMAGE_EMPTY");
      await svc.entities.ViralityPlanPost.update(post.id, { image_url: url, image_status: "ready", image_error: null });
      await svc.entities.ViralityPlan.update(plan.id, { updated_at: nowIso() });
      await hold.settle(POST_IMAGE_CREDITS, "Generate a post image", { operation: "generate_image" });
      return { post_id, image_url: url };
    } catch (e) {
      await hold.fail();
      throw e;
    }
  }

  if (action === "reset") {
    // Documented: clears everything so the flow can start over; a reset does NOT refund
    // credits already spent — the ledger is simply untouched here.
    await deletePlanAndPosts(svc, project.id);
    if (row0) await svc.entities.ViralityState.delete(row0.id).catch(() => {});
    const dups = await svc.entities.ViralityState.filter({ project_id: project.id }, "created_date", 10).catch(() => []);
    for (const dup of dups) await svc.entities.ViralityState.delete(dup.id).catch(() => {});
    return { stage: "idle", questions: null, analysis_text: null, answers: null, strategy_text: null, plan: null };
  }

  throw err(`Unknown action "${action}"`, 400, "UNKNOWN_ACTION");
}

// --- the background image executor (queued through the EXISTING job queue) ------------
// Idempotent: a retried or replayed job converges (ready posts are skipped; a deleted
// post's job resolves quietly). Terminal failures mark the post failed instead of
// retrying — image failures are deterministic, copy generation already succeeded.
export async function executeViralityImageJob(svc, { project_id, plan_id, post_id }, { imageGenerator = null } = {}) {
  const gen = imageGenerator || REAL_GENERATORS.image;
  const post = (await svc.entities.ViralityPlanPost.filter({ project_id, plan_id, post_id }, "created_date", 1).catch(() => []))[0] || null;
  if (!post || post.project_id !== project_id || post.plan_id !== plan_id) return { skipped: "post_gone" };
  if (post.image_status === "ready") return { skipped: "already_ready", post_id };
  if (post.image_status === "failed") return { skipped: "already_failed", post_id };
  try {
    const url = await gen(svc, { prompt: post.image_prompt || `Clean promotional visual for a ${post.platform} post` });
    await svc.entities.ViralityPlanPost.update(post.id, url
      ? { image_url: url, image_status: "ready", image_error: null }
      : { image_status: "failed", image_error: "Image generation returned no image" });
    return { post_id, image_url: url || null, status: url ? "ready" : "failed" };
  } catch (e) {
    await svc.entities.ViralityPlanPost.update(post.id, { image_status: "failed", image_error: String(e?.message || e).slice(0, 200) }).catch(() => {});
    return { post_id, status: "failed" };
  }
}