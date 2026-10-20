// Base44 Virality Engine — Phase 2: Social Calendar + publishing.
// Pinned by the DOCUMENTED contract (docs.base44.com/developers/references/apps-api/sections/virality
// + the /api-reference list|create|update|delete|approve-scheduled-posts and
// start|get-scheduling-job pages). Phase 1's surface (shared/virality.ts) is UNTOUCHED — the
// calendar dispatches from functions/virality's entry, never through viralitySurface.
//
// Parity:
//   • ONE calendar per app — the ViralityScheduledPost rows of the project; list returns the
//     WHOLE calendar in one response, no paging; passing the CURRENT plan's id materializes
//     its suggestions into proposal rows (idempotent) and does NOT filter the response;
//   • statuses proposal | scheduled | publishing | posted | failed | publish_outcome_unknown |
//     needs_reconnect | not_materialized_plan_limit; only proposal and scheduled are editable
//     or deletable — every other state refuses with 409; platform is immutable;
//   • suggestions not acted on are dropped when the plan that produced them is replaced —
//     implemented as the purge, on every list, of proposal rows whose plan is no longer the
//     current one; approved / edited / scheduled rows survive (an edited proposal is detached
//     from its plan, the NEXUSAI encoding of "already turned into a real post");
//   • approve: 1..50 ids (documented), repeats collapsed, selection semantics — approved /
//     not_found / rejected[{id, status}]; re-approving a scheduled row lands in approved
//     without a write;
//   • start scheduling: [scheduled_from, scheduled_until), until strictly later than from,
//     ISO 8601 carrying an offset; 202 + the in-flight job for the range (idempotent per
//     range); an empty range completes straight away; a non-publishable platform (x, tiktok,
//     reddit) FAILS the post immediately, since there is nowhere to publish it;
//   • job: status pending | running | completed | failed; result counters (selected,
//     materialized, created_workflows, reused_workflows, plan_limited, needs_reconnect,
//     failed, skipped) set once completed; error is the FIXED "Scheduling failed. Please try
//     again." with no cause detail; phase is display-only — read status, not phase;
//   • duplicate-publication protection: ONE idempotent publish job per post
//     (virality:publish:<post_id>) through the EXISTING job queue (lease + idempotent
//     enqueue); the executor skips posted / failed / needs_reconnect rows, refuses fresh
//     in-flight markers, and converges a stale marker (a worker died mid-send) to the
//     documented publish_outcome_unknown — never guessed back to posted;
//   • publishing: linkedin through the CONFIRMED UGC contract; facebook through the
//     connector-verified Pages path; instagram's publish contract unverified → fail CLOSED;
//     missing connection/permission → needs_reconnect (fail-closed, documented status).
//
// UNKNOWN in Base44's contract, marked rather than invented:
//   • the scheduled_at derivation for plan-materialized proposals (the plan carries
//     suggested_day + best_time_reason but no formula) — NEXUSAI-DERIVED: plan creation
//     + suggested_day days at 12:00 UTC, timezone UTC;
//   • the not_materialized_plan_limit outcome (which plan tier covers publishing is not
//     published) — never produced; plan_limited stays 0;
//   • phase internals (the documented sandbox_sync / finalize) — a minimal NEXUSAI phase is
//     reported; status, not phase, decides completion;
//   • workflow_id semantics — mapped to THIS runtime's publish job id;
//   • validation limits for title/body length and the scheduled_timezone pool beyond "IANA"
//     (validated against Intl; content bounds reused from Phase 1, NEXUSAI-owned);
//   • the rate-limit pools (15/20/40 rpm) are platform infrastructure this runtime does not own;
//   • publishing retry semantics (a failed post is NOT retried; the crash-detection staleness
//     bound is NEXUSAI-DERIVED);
//   • teaser and post analytics — still out of scope (Phase 1 decision).
import { err, PLATFORMS, PUBLISHABLE_PLATFORMS, getCurrentPlan } from "./virality.ts";
import { enqueue } from "./jobQueue.ts";
import { tzOffsetMs } from "./cron.ts";
import { PUBLISHERS, resolveConnection, NO_CONNECTION, PERMISSION_MISSING } from "./socialPublish.ts";
import { log } from "./observability.ts";
import { assertViralityPublishEntitlement } from "./planLimits.ts";
import { prepareTikTokPost, assertOwnTikTokReady } from "./tiktokPublishing.ts";
import { executeOwnTikTokJob } from "./tiktokSocialJob.ts";

export const SCHEDULE_JOB_TYPE = "virality.schedule";
export const PUBLISH_JOB_TYPE = "virality.publish";

const EDITABLE_STATUSES = ["proposal", "scheduled"];
const MAX_APPROVE_IDS = 50; // documented: 1 to 50 ids per approve call
const PUBLISHING_STALE_MS = 15 * 60 * 1000; // NEXUSAI-DERIVED: a publish in flight longer than this is un-confirmable
const CAL_FETCH_LIMIT = 500;
const CONTENT_BOUND = 50000; // NEXUSAI bound, reused from Phase 1
const SCHEDULING_FAILED_MESSAGE = "Scheduling failed. Please try again."; // the documented FIXED error

const nowIso = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

// --- timezone / scheduled_at handling (the EXISTING scheduler primitive) ----------------------
// tzOffsetMs is the cron scheduler's DST-correct IANA offset helper; an unknown zone throws,
// which is the validation. scheduled_local_at carries the zone's real offset.
export function validTimezone(tz) {
  const name = clean(tz, 100) || "UTC";
  try {
    tzOffsetMs(new Date("2026-01-01T00:00:00Z"), name);
    return name;
  } catch {
    return null;
  }
}

function localIso(utcIso, tz) {
  const t = new Date(utcIso);
  // The offset is rounded to whole minutes (it can carry sub-second residue from the instant's
  // milliseconds) before the ±HH:MM suffix is built — an offset like +02:60 can never leak out.
  const offMin = Math.round(tzOffsetMs(t, tz) / 60000); // minutes to ADD to the UTC instant for the zone's wall clock
  const wall = new Date(t.getTime() + offMin * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  const abs = Math.abs(offMin);
  const offset = `${offMin >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}${offset}`;
}

const parseScheduledAt = (raw) => {
  const t = Date.parse(String(raw || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// --- projection (the documented response shape) ------------------------------------------------
function projectRow(row, appId) {
  return {
    id: row.id,
    app_id: appId,
    plan_id: row.plan_id || null,
    source_post_id: row.source_post_id || null,
    platform: row.platform,
    title: row.title || "",
    body: row.body || "",
    hook: row.hook ?? "",
    cover_index: Number.isFinite(row.cover_index) ? row.cover_index : 0,
    scheduled_at: row.scheduled_at || null,
    scheduled_local_at: row.scheduled_local_at || null,
    scheduled_timezone: row.scheduled_timezone || "UTC",
    best_time_reason: row.best_time_reason || "",
    hashtags: row.hashtags || [],
    image_url: row.image_url || null,
    image_prompt: row.image_prompt || null,
    status: row.status,
    workflow_id: row.workflow_id || null,
  };
}

const normalizeHashtags = (tags) =>
  Array.isArray(tags) ? tags.slice(0, 30).map((h) => String(h).replace(/^#/, "").slice(0, 100)).filter(Boolean) : [];

// --- list + materialization ---------------------------------------------------------------------
async function listPosts(svc, project, planIdInput) {
  const plan = await getCurrentPlan(svc, project.id);

  // Suggestions not acted on are dropped when their plan was replaced — checked on EVERY list.
  // Approved / edited / scheduled rows survive: only proposal rows whose plan is no longer
  // current are dropped (a detached proposal has no plan_id and is never dropped).
  const proposals = await svc.entities.ViralityScheduledPost.filter({ project_id: project.id, status: "proposal" }, "created_date", CAL_FETCH_LIMIT).catch(() => []);
  for (const p of proposals) {
    if (p.plan_id && (!plan || p.plan_id !== plan.plan_id)) {
      await svc.entities.ViralityScheduledPost.delete(p.id).catch(() => {});
    }
  }

  // Materialize the CURRENT plan's suggestions when the caller passes its id (documented);
  // idempotent — a suggestion is never materialized twice.
  if (planIdInput && plan && String(planIdInput) === plan.plan_id) {
    const planPosts = await svc.entities.ViralityPlanPost.filter({ project_id: project.id, plan_id: plan.plan_id }, "created_date", 200).catch(() => []);
    const existing = await svc.entities.ViralityScheduledPost.filter({ project_id: project.id }, "created_date", CAL_FETCH_LIMIT).catch(() => []);
    const seen = new Set(existing.map((r) => r.source_post_id).filter(Boolean));
    const fresh = planPosts
      .filter((p) => p.post_id && !seen.has(p.post_id))
      .map((p) => {
        // NEXUSAI-DERIVED (UNKNOWN in Base44): plan suggestions carry suggested_day, not an
        // absolute time — the proposal materializes at plan creation + suggested_day days, 12:00 UTC.
        const base = Date.parse(plan.created_at || nowIso()) || Date.now();
        const t = new Date(base + Math.max(0, Number(p.suggested_day) || 0) * 86400000);
        t.setUTCHours(12, 0, 0, 0);
        const scheduled_at = t.toISOString();
        return {
          project_id: project.id, workspace_id: project.workspace_id,
          plan_id: plan.plan_id, source_post_id: p.post_id,
          platform: p.platform, title: p.post_title || "", body: p.content || "",
          hook: p.angle || "", cover_index: Math.max(0, (p.post_number || 1) - 1),
          scheduled_at, scheduled_local_at: localIso(scheduled_at, "UTC"), scheduled_timezone: "UTC",
          best_time_reason: p.best_time_reason || "", hashtags: p.hashtags || [],
          image_url: p.image_url || null, image_prompt: p.image_prompt || null,
          status: "proposal", workflow_id: null, publish_started_at: null, publish_error: null,
        };
      });
    if (fresh.length) await svc.entities.ViralityScheduledPost.bulkCreate(fresh);
  }

  const all = await svc.entities.ViralityScheduledPost.filter({ project_id: project.id }, "created_date", CAL_FETCH_LIMIT).catch(() => []);
  return all.map((r) => projectRow(r, project.id));
}

// --- create / update / delete ---------------------------------------------------------------------
async function createPost(svc, project, input, user, options) {
  const platform = clean(input.platform, 32).toLowerCase();
  if (!PLATFORMS.includes(platform)) {
    throw err(`platform must be one of ${PLATFORMS.join(", ")}`, 400, "INVALID_PLATFORM");
  }
  const body = clean(input.body, CONTENT_BOUND);
  if (!body) throw err("body is required", 400, "BODY_REQUIRED");
  if (!clean(input.scheduled_at, 100)) throw err("scheduled_at is required", 400, "SCHEDULED_AT_REQUIRED");
  const scheduled_at = parseScheduledAt(input.scheduled_at);
  if (!scheduled_at) throw err("scheduled_at is not a valid ISO 8601 timestamp", 422, "INVALID_SCHEDULED_AT");
  const tz = input.scheduled_timezone === undefined || input.scheduled_timezone === null || String(input.scheduled_timezone).trim() === ""
    ? "UTC" : clean(input.scheduled_timezone, 100);
  if (!validTimezone(tz)) throw err(`scheduled_timezone "${tz}" is not a known IANA zone`, 422, "INVALID_TIMEZONE");
  const tiktok = platform === "tiktok" && (input.tiktok_credential_id || input.video_url || input.tiktok_settings)
    ? await prepareTikTokPost(svc, project, user, { ...input, body, hashtags: normalizeHashtags(input.hashtags) }, options?.tiktok) : {};
  const row = await svc.entities.ViralityScheduledPost.create({
    project_id: project.id, workspace_id: project.workspace_id,
    ...tiktok,
    plan_id: null, source_post_id: null,
    platform, title: clean(input.title, 300), body, hook: clean(input.hook, 60),
    cover_index: 0, scheduled_at,
    scheduled_local_at: localIso(scheduled_at, tz), scheduled_timezone: tz,
    best_time_reason: clean(input.best_time_reason, 1000),
    hashtags: normalizeHashtags(input.hashtags),
    image_url: input.image_url ? clean(input.image_url, 2000) : null,
    image_prompt: input.image_prompt ? clean(input.image_prompt, 2000) : null,
    // The documented create example returns status "scheduled" — an authored post is a real post.
    status: "scheduled", workflow_id: null, publish_started_at: null, publish_error: null,
  });
  return projectRow(row, project.id);
}

async function loadPost(svc, project, postId) {
  const row = await svc.entities.ViralityScheduledPost.get(String(postId || "")).catch(() => null);
  if (!row || row.project_id !== project.id) {
    throw err("The scheduled post was not found", 404, "POST_NOT_FOUND");
  }
  return row;
}

async function updatePost(svc, project, postId, input, user, options) {
  const row = await loadPost(svc, project, postId);
  if (!EDITABLE_STATUSES.includes(row.status)) {
    throw err(`A ${row.status} post can no longer be edited`, 409, "STATUS_NOT_EDITABLE");
  }
  const patch = {};
  if (input.title !== undefined) patch.title = clean(input.title, 300);
  if (input.body !== undefined) {
    const b = clean(input.body, CONTENT_BOUND);
    if (!b) throw err("body cannot be empty", 400, "BODY_REQUIRED");
    patch.body = b;
  }
  let tz = row.scheduled_timezone || "UTC";
  if (input.scheduled_timezone !== undefined && input.scheduled_timezone !== null && String(input.scheduled_timezone).trim() !== "") {
    tz = clean(input.scheduled_timezone, 100);
    if (!validTimezone(tz)) throw err(`scheduled_timezone "${tz}" is not a known IANA zone`, 422, "INVALID_TIMEZONE");
    patch.scheduled_timezone = tz;
  }
  let at = row.scheduled_at;
  if (input.scheduled_at !== undefined && input.scheduled_at !== null && String(input.scheduled_at).trim() !== "") {
    at = parseScheduledAt(input.scheduled_at);
    if (!at) throw err("scheduled_at is not a valid ISO 8601 timestamp", 422, "INVALID_SCHEDULED_AT");
    patch.scheduled_at = at;
  }
  patch.scheduled_local_at = localIso(at, tz);
  if (input.hook !== undefined) patch.hook = clean(input.hook, 60);
  if (input.best_time_reason !== undefined) patch.best_time_reason = clean(input.best_time_reason, 1000);
  if (input.hashtags !== undefined) patch.hashtags = normalizeHashtags(input.hashtags);
  if (input.image_url !== undefined) patch.image_url = input.image_url ? clean(input.image_url, 2000) : null;
  if (input.image_prompt !== undefined) patch.image_prompt = input.image_prompt ? clean(input.image_prompt, 2000) : null;
  if (row.platform === "tiktok" && ["body", "hashtags", "video_url", "video_duration_sec", "tiktok_settings", "tiktok_credential_id"].some((field) => input[field] !== undefined)) {
    Object.assign(patch, await prepareTikTokPost(svc, project, user, { ...row, ...input, ...patch }, options?.tiktok));
  }
  // Editing a plan suggestion turns it into a real post (documented "stays"): detach it from
  // the plan so a later plan replacement can never drop it. source_post_id is KEPT so the
  // suggestion is never re-materialized (NEXUSAI encoding — the mechanism is not documented).
  if (row.status === "proposal") patch.plan_id = null;
  const updated = await svc.entities.ViralityScheduledPost.update(row.id, patch);
  return projectRow(updated, project.id);
}

async function deletePost(svc, project, postId) {
  const row = await svc.entities.ViralityScheduledPost.get(String(postId || "")).catch(() => null);
  // Idempotent by contract: {status:"ok"} whether it was deleted now or already.
  if (!row || row.project_id !== project.id) return { status: "ok" };
  if (!EDITABLE_STATUSES.includes(row.status)) {
    throw err(`A ${row.status} post can no longer be deleted`, 409, "STATUS_NOT_EDITABLE");
  }
  await svc.entities.ViralityScheduledPost.delete(row.id).catch(() => {});
  return { status: "ok" };
}

// --- approve (a selection — one unusable id never discards the rest) ------------------------------
async function approvePosts(svc, project, ids) {
  const raw = Array.isArray(ids) ? ids : [];
  const unique = [...new Set(raw.map((v) => String(v || "").trim()).filter(Boolean))];
  if (!unique.length) throw err("post_ids must contain 1 to 50 ids", 400, "APPROVE_IDS_REQUIRED");
  if (unique.length > MAX_APPROVE_IDS) throw err(`At most ${MAX_APPROVE_IDS} posts can be approved per call`, 422, "TOO_MANY_IDS");
  const rows = await svc.entities.ViralityScheduledPost.filter({ project_id: project.id }, "created_date", CAL_FETCH_LIMIT).catch(() => []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const approved = [], not_found = [], rejected = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) { not_found.push(id); continue; }
    if (row.status === "scheduled") { approved.push(id); continue; } // re-approve: no write
    if (row.status === "proposal") {
      await svc.entities.ViralityScheduledPost.update(row.id, { status: "scheduled" }).catch(() => {});
      approved.push(id);
      continue;
    }
    rejected.push({ id, status: row.status });
  }
  return { approved, not_found, rejected };
}

// --- the scheduling job ----------------------------------------------------------------------------
async function startScheduling(svc, project, workspace, input) {
  const fromRaw = clean(input.scheduled_from, 100), untilRaw = clean(input.scheduled_until, 100);
  if (!fromRaw || !untilRaw) throw err("scheduled_from and scheduled_until are required", 400, "RANGE_REQUIRED");
  const from = Date.parse(fromRaw), until = Date.parse(untilRaw);
  if (!Number.isFinite(from) || !Number.isFinite(until)) {
    throw err("scheduled_from/scheduled_until must be ISO 8601 timestamps carrying an offset", 422, "INVALID_RANGE");
  }
  if (until <= from) throw err("scheduled_until has to be later than scheduled_from", 422, "INVALID_RANGE");
  // DOCUMENTED Base44: "Publishing requires a paid workspace plan." A free/non-entitled workspace
  // cannot hand posts to the publisher — the start-scheduling choke point fails closed BEFORE any
  // job is enqueued. create/approve/list remain available on every plan.
  await assertViralityPublishEntitlement(svc, workspace);
  const fromIso = new Date(from).toISOString(), untilIso = new Date(until).toISOString();
  // The in-flight job for this range is returned again rather than started twice (documented).
  const { job } = await enqueue(svc, {
    queue: "default", job_type: SCHEDULE_JOB_TYPE,
    payload: { project_id: project.id, scheduled_from: fromIso, scheduled_until: untilIso },
    idempotency_key: `virality:sched:${project.id}:${fromIso}:${untilIso}`,
    workspace_id: workspace.id, project_id: project.id,
  });
  return schedulingJobBody(job);
}

/** The documented job projection. status decides completion; phase is display-only (NEXUSAI-minimal). */
export function schedulingJobBody(job) {
  const status = job.status === "pending" ? "pending" : job.status === "leased" ? "running" : job.status === "succeeded" ? "completed" : "failed";
  const phase = job.status === "pending" ? "pending" : job.status === "leased" ? "prepare" : "completed";
  const result = status === "completed" && job.result && typeof job.result === "object" ? job.result : null;
  return { job_id: job.id, status, phase, result, error: status === "failed" ? SCHEDULING_FAILED_MESSAGE : null };
}

/** The queued scheduling executor: selects scheduled posts in the range and materializes each. */
export async function executeViralityScheduleJob(svc, { project_id, scheduled_from, scheduled_until }, { getConnection = null, tiktok = {} } = {}) {
  const rows = await svc.entities.ViralityScheduledPost.filter({ project_id, status: "scheduled" }, "created_date", CAL_FETCH_LIMIT).catch(() => []);
  const from = Date.parse(scheduled_from), until = Date.parse(scheduled_until);
  const selected = rows.filter((r) => {
    const t = Date.parse(r.scheduled_at);
    return Number.isFinite(t) && t >= from && t < until;
  });
  const result = {
    selected: selected.length, materialized: 0, created_workflows: 0, reused_workflows: 0,
    plan_limited: 0, needs_reconnect: 0, failed: 0, skipped: 0,
  };
  for (const row of selected) {
    // The base allowlist is unchanged. TikTok is added for THIS row only after its OWN
    // project/user credential grants video.publish and creator_info confirms capability.
    const availablePlatforms = [...PUBLISHABLE_PLATFORMS];
    if (row.platform === "tiktok" && row.tiktok_credential_id) {
      try { await assertOwnTikTokReady(svc, row, tiktok); availablePlatforms.push("tiktok"); }
      catch (error) {
        const next = ["NO_CONNECTION", "PERMISSION_MISSING", "NOT_A_MEMBER", "INSUFFICIENT_ROLE", "WORKSPACE_INACTIVE", "OAUTH_REFRESH_FAILED"].includes(error.code) ? "needs_reconnect" : "failed";
        await svc.entities.ViralityScheduledPost.update(row.id, { status: next, publish_error: String(error.code || "TIKTOK_CAPABILITY_UNAVAILABLE"), publish_started_at: null });
        result[next === "needs_reconnect" ? "needs_reconnect" : "failed"]++;
        continue;
      }
    }
    // A platform with no available publisher is still failed immediately.
    if (!availablePlatforms.includes(row.platform)) {
      await svc.entities.ViralityScheduledPost.update(row.id, { status: "failed", publish_error: `${row.platform} has no publisher`, publish_started_at: null }).catch(() => {});
      result.failed++;
      continue;
    }
    // plan_limited stays 0: which plan tier covers publishing is UNKNOWN (not published).
    const conn = row.platform === "tiktok" && row.tiktok_credential_id ? { own_oauth_verified: true } : await resolveConnection(svc, row.platform, { getConnection }).catch(() => null);
    if (!conn) {
      await svc.entities.ViralityScheduledPost.update(row.id, { status: "needs_reconnect", publish_error: null, publish_started_at: null }).catch(() => {});
      result.needs_reconnect++;
      continue;
    }
    // ONE idempotent publish job per post — the duplicate-publication guard.
    const { job, duplicate } = await enqueue(svc, {
      queue: "default", job_type: PUBLISH_JOB_TYPE,
      payload: { project_id, post_id: row.id },
      max_attempts: 3,
      idempotency_key: `virality:publish:${row.id}`,
      workspace_id: row.workspace_id || null, project_id,
      delay_ms: Math.max(0, Date.parse(row.scheduled_at) - Date.now()),
    });
    await svc.entities.ViralityScheduledPost.update(row.id, { workflow_id: job.id, publish_error: null }).catch(() => {});
    result.materialized++;
    if (duplicate) result.reused_workflows++; else result.created_workflows++;
  }
  log("info", "virality.schedule_job.completed", { project_id, selected: result.selected, materialized: result.materialized });
  return result;
}

/** The queued per-post publisher: idempotent, fail-closed, never guesses a crash into a success. */
export async function executeViralityPublishJob(svc, { project_id, post_id }, { publishers = PUBLISHERS } = {}) {
  const row = await svc.entities.ViralityScheduledPost.get(String(post_id || "")).catch(() => null);
  if (!row || row.project_id !== project_id) return { skipped: "post_gone" };
  if (row.platform === "tiktok" && row.tiktok_credential_id) return executeOwnTikTokJob(svc, row, { publisher: publishers.tiktok });
  if (row.status === "posted") return { skipped: "already_published", post_id };
  if (row.status === "failed" || row.status === "publish_outcome_unknown" || row.status === "needs_reconnect" || row.status === "not_materialized_plan_limit") {
    return { skipped: `already_${row.status}`, post_id };
  }
  if (row.status === "publishing") {
    const age = Date.now() - Date.parse(row.publish_started_at || "");
    if (Number.isFinite(age) && age >= 0 && age < PUBLISHING_STALE_MS) return { skipped: "in_flight", post_id };
    // A worker died mid-send: the outcome cannot be confirmed — the documented status, never guessed.
    await svc.entities.ViralityScheduledPost.update(row.id, { status: "publish_outcome_unknown", publish_started_at: null }).catch(() => {});
    return { post_id, status: "publish_outcome_unknown" };
  }
  if (row.status !== "scheduled") return { skipped: "not_scheduled", post_id }; // proposals are never published
  const publisher = publishers[row.platform];
  if (!publisher) {
    await svc.entities.ViralityScheduledPost.update(row.id, { status: "failed", publish_error: `${row.platform} has no publisher`, publish_started_at: null }).catch(() => {});
    return { post_id, status: "failed" };
  }
  await svc.entities.ViralityScheduledPost.update(row.id, { status: "publishing", publish_started_at: nowIso() }).catch(() => {});
  try {
    const ref = await publisher(svc, row);
    await svc.entities.ViralityScheduledPost.update(row.id, { status: "posted", publish_started_at: null, publish_error: null });
    return { post_id: row.id, status: "posted", ref: ref || null };
  } catch (e) {
    // A failed post is NOT retried (documented). A missing connection/permission is the
    // documented needs_reconnect; anything else is a failed post.
    const next = e?.code === NO_CONNECTION || e?.code === PERMISSION_MISSING ? "needs_reconnect" : "failed";
    await svc.entities.ViralityScheduledPost.update(row.id, { status: next, publish_started_at: null, publish_error: String(e?.message || e).slice(0, 300) }).catch(() => {});
    return { post_id: row.id, status: next, error: String(e?.message || e).slice(0, 300) };
  }
}

// --- the member-authorized surface (dispatched from functions/virality's entry) ---------------------
export const CALENDAR_ACTIONS = new Set([
  "calendar_list", "calendar_create", "calendar_update", "calendar_delete",
  "calendar_approve", "calendar_schedule", "calendar_schedule_job",
]);

export async function calendarSurface(svc, project, workspace, user, input, options = {}) {
  void workspace;
  const action = String(input.action || "calendar_list");
  switch (action) {
    case "calendar_list":
      return listPosts(svc, project, input.plan_id);
    case "calendar_create":
      return createPost(svc, project, input, user, options);
    case "calendar_update":
      return updatePost(svc, project, input.post_id, input, user, options);
    case "calendar_delete":
      return deletePost(svc, project, input.post_id);
    case "calendar_approve":
      return approvePosts(svc, project, input.post_ids);
    case "calendar_schedule":
      return startScheduling(svc, project, workspace, input);
    case "calendar_schedule_job": {
      const job_id = clean(input.job_id, 100);
      if (!job_id) throw err("job_id is required", 400, "JOB_ID_REQUIRED");
      const job = await svc.entities.BackgroundJob.get(job_id).catch(() => null);
      if (!job || job.project_id !== project.id || job.job_type !== SCHEDULE_JOB_TYPE) {
        throw err("Scheduling job not found", 404, "JOB_NOT_FOUND");
      }
      return schedulingJobBody(job);
    }
  }
  throw err(`Unknown action "${action}"`, 400, "UNKNOWN_ACTION");
}