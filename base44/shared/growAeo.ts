// Runable Grow — Phase 5: AEO / AI visibility.
//
// The app's own language model is the ONLY measurement engine (the EXISTING Core InvokeLLM
// seam, the same one the certified virality generators and lead generation use): each probe
// asks an assistant-style question, the answer's recommendations are scanned deterministically
// for the project's name, and the measurement (mentioned, rank, excerpt) lands in AeoResult.
// There is NO real assistant-API integration behind this (Base44 documents no such provider
// surface — UNKNOWN, never invented): the model call measures what a generative answer says.
//
//   • probes: bounded (max 10 per project, question 10..300 chars), idempotent to re-add
//     (the same question returns the existing row);
//   • determinism/idempotency: a run carries a run_key — a re-run of the SAME run_key returns
//     the stored measurements with NO second model call and NO second credit charge;
//   • credits fail closed: one hold BEFORE the calls (per-probe worst case), settled on
//     success, released on failure — the same certified hold/settle/fail shape virality uses;
//   • tenant isolation: rows carry the authorized project_id and reads are filtered by it;
//   • scheduling: the certified job queue (no second scheduler) — one idempotent job per
//     interval bucket, the executor self-rescheduling while active probes remain.
//     The default interval is NEXUSAI-DERIVED (the documented cadence is UNKNOWN).

import { err } from "./virality.ts";
import { holdIntegrationCredits } from "./integrationCharges.ts";
import { enqueue } from "./jobQueue.ts";

export const AEO_JOB_TYPE = "grow.aeo";
export const MAX_PROBES = 10;
export const QUESTION_MIN = 10;
export const QUESTION_MAX = 300;
export const AEO_CREDITS_PER_PROBE = 2; // NEXUSAI-native estimate: one bounded model call per probe
export const DEFAULT_INTERVAL_MINUTES = 720; // NEXUSAI-DERIVED (UNKNOWN): the documented cadence is not published

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const nowIso = () => new Date().toISOString();

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, reason: { type: "string" } },
        required: ["name"],
      },
    },
  },
  required: ["recommendations"],
};

export const projectProbe = (p) => ({ id: p.id, question: p.question, status: p.status || "active" });

export async function addProbe(svc, project, workspace, input) {
  const question = clean(input.question, QUESTION_MAX);
  if (question.length < QUESTION_MIN) throw err(`question must be at least ${QUESTION_MIN} characters`, 400, "QUESTION_TOO_SHORT");
  const existing = await svc.entities.AeoProbe.filter({ project_id: project.id }, "created_date", MAX_PROBES * 2);
  const same = existing.find((p) => p.question === question);
  if (same) return { deduped: true, probe: projectProbe(same) };
  if (existing.filter((p) => (p.status || "active") === "active").length >= MAX_PROBES) {
    throw err(`At most ${MAX_PROBES} probes per project`, 422, "TOO_MANY_PROBES");
  }
  const row = await svc.entities.AeoProbe.create({ project_id: project.id, workspace_id: workspace.id, question, status: "active" });
  return { deduped: false, probe: projectProbe(row) };
}

export async function removeProbe(svc, project, probe_id) {
  const row = (await svc.entities.AeoProbe.filter({ id: probe_id }, "created_date", 1))[0] || null;
  if (!row || row.project_id !== project.id) throw err("The probe is not in this project", 404, "PROBE_NOT_FOUND");
  await svc.entities.AeoProbe.delete(row.id);
  return { removed: probe_id };
}

export async function listProbes(svc, project) {
  const rows = await svc.entities.AeoProbe.filter({ project_id: project.id }, "created_date", MAX_PROBES * 2).catch(() => []);
  return { probes: rows.map(projectProbe) };
}

export const REAL_GENERATORS = {
  answer: async (svc, { question }) => {
    const out = await svc.integrations.Core.InvokeLLM({
      prompt:
        `You are a helpful assistant. A user asks: "${question}".\n` +
        `Recommend up to 5 real, existing products or tools that fit, each with a one-sentence reason. ` +
        `Only name real, publicly documented products — never invent companies or tools.`,
      response_json_schema: ANSWER_SCHEMA,
    });
    return out;
  },
};

/** Deterministic extraction: the project's name among the recommendations (case-insensitive). */
export const extractMention = (project, recommendations) => {
  const needle = String(project.name || "").trim().toLowerCase();
  if (!needle) return { mentioned: false, rank: null, excerpt: clean(recommendations?.[0]?.reason, 300) || null };
  const recs = Array.isArray(recommendations) ? recommendations : [];
  const idx = recs.findIndex((r) => clean(r?.name, 200).toLowerCase().includes(needle));
  if (idx < 0) return { mentioned: false, rank: null, excerpt: clean(recs[0]?.reason, 300) || null };
  return { mentioned: true, rank: idx + 1, excerpt: clean(recs[idx]?.reason, 300) || null };
};

/** One bounded AEO run over the project's active probes. `generators` is the certification
 *  seam (production never passes one). A repeated run_key is served from storage, free. */
export async function runProbes(svc, project, workspace, input = {}, { generators = {} } = {}) {
  const gen = { ...REAL_GENERATORS, ...(generators || {}) };
  const workspace_id = workspace?.id || project.workspace_id;
  const run_key = clean(input.run_key, 100) || `aeo_${crypto.randomUUID()}`;
  const probes = (await svc.entities.AeoProbe.filter({ project_id: project.id }, "created_date", MAX_PROBES * 2).catch(() => []))
    .filter((p) => (p.status || "active") === "active");
  if (!probes.length) return { run_key, probes: [], counts: { measured: 0, mentioned: 0 } };

  const prior = (await svc.entities.AeoResult.filter({ project_id: project.id, run_key }, "created_date", MAX_PROBES * 2).catch(() => []));
  if (prior.length >= probes.length) {
    return { run_key, deduped: true, probes: prior.map((r) => ({ probe_id: r.probe_id, question: r.question, mentioned: r.mentioned, rank: r.rank ?? null })), counts: { measured: prior.length, mentioned: prior.filter((r) => r.mentioned).length } };
  }

  const hold = await holdIntegrationCredits(svc, {
    workspace_id, project_id: project.id, user_id: input.user_id || null,
    credits: probes.length * AEO_CREDITS_PER_PROBE, key: `grow:aeo:${run_key}`,
    reason: `AEO measurement (${probes.length} probes)`,
  });
  try {
    const rows = [];
    for (const probe of probes) {
      const out = await gen.answer(svc, { question: probe.question, project });
      const m = extractMention(project, out?.recommendations);
      rows.push({
        project_id: project.id, workspace_id, probe_id: probe.id, question: probe.question,
        run_key, mentioned: m.mentioned, rank: m.rank, excerpt: m.excerpt || null, checked_at: nowIso(),
      });
    }
    const stored = await svc.entities.AeoResult.bulkCreate(rows);
    await hold.settle(probes.length * AEO_CREDITS_PER_PROBE, "AEO measurement", { probes: stored.length });
    return { run_key, probes: stored.map((r) => ({ probe_id: r.probe_id, question: r.question, mentioned: r.mentioned, rank: r.rank ?? null })), counts: { measured: stored.length, mentioned: stored.filter((r) => r.mentioned).length } };
  } catch (e) {
    await hold.fail().catch(() => {});
    throw e;
  }
}

/** The deterministic visibility report, computed ONLY from stored measurements. */
export async function buildAeoReport(svc, project, { since_days = 7 } = {}) {
  const days = Math.max(1, Math.min(90, Number(since_days) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (await svc.entities.AeoResult.filter({ project_id: project.id }, "created_date", 500).catch(() => []))
    .filter((o) => (o.checked_at || o.created_date || "") >= since);
  const byProbe = new Map();
  for (const o of rows) {
    const g = byProbe.get(o.probe_id) || { probe_id: o.probe_id, question: o.question, runs: 0, mentioned_runs: 0, best_rank: null, latest_excerpt: null };
    g.runs++;
    if (o.mentioned) {
      g.mentioned_runs++;
      if (g.best_rank === null || (Number.isFinite(o.rank) && o.rank < g.best_rank)) g.best_rank = o.rank;
    }
    g.latest_excerpt = o.excerpt || g.latest_excerpt;
    byProbe.set(o.probe_id, g);
  }
  return {
    generated_at: nowIso(),
    window_days: days,
    total_measurements: rows.length,
    overall_visibility: rows.length ? Math.round((rows.filter((r) => r.mentioned).length / rows.length) * 100) / 100 : 0,
    probes: [...byProbe.values()].map((g) => ({ ...g, visibility: Math.round((g.mentioned_runs / g.runs) * 100) / 100 })).sort((a, b) => b.visibility - a.visibility),
  };
}

const clampInterval = (v) => Math.max(60, Math.min(10080, Number(v) || DEFAULT_INTERVAL_MINUTES));

/** ONE idempotent AEO job per interval bucket (the queue's dedup; no second scheduler). */
export async function scheduleAeo(svc, project, workspace, { interval_minutes } = {}) {
  const interval = clampInterval(interval_minutes);
  const bucket = Math.floor(Date.now() / (interval * 60000)) * (interval * 60000);
  const res = await enqueue(svc, {
    queue: "default", job_type: AEO_JOB_TYPE,
    payload: { project_id: project.id, interval_minutes: interval },
    delay_ms: 0, max_attempts: 3,
    idempotency_key: `aeo:${project.id}:${bucket}`,
    workspace_id: workspace.id, project_id: project.id,
  });
  return { interval_minutes: interval, job_id: res.job?.id || null, duplicate: Boolean(res.duplicate), next_run_at: res.job?.available_at || null };
}

/** The queued AEO job: measure, then keep the chain alive while active probes remain. */
export async function executeAeoJob(svc, { project_id, interval_minutes }, { generators = null } = {}) {
  const project = await svc.entities.Project.get(String(project_id || "")).catch(() => null);
  if (!project) throw Object.assign(new Error("the project no longer exists"), { retryable: false, code: "INVALID_PAYLOAD" });
  const interval = clampInterval(interval_minutes);
  const run = await runProbes(svc, project, null, { run_key: `sched_${interval}_${Math.floor(Date.now() / (interval * 60000))}` }, { ...(generators ? { generators } : {}) });
  const active = (await svc.entities.AeoProbe.filter({ project_id: project.id, status: "active" }, "created_date", 1).catch(() => []));
  let next = null;
  if (active.length) {
    const nextBucket = Math.floor((Date.now() + interval * 60000) / (interval * 60000)) * (interval * 60000);
    const out = await enqueue(svc, {
      queue: "default", job_type: AEO_JOB_TYPE,
      payload: { project_id: project.id, interval_minutes: interval },
      delay_ms: Math.max(60000, nextBucket - Date.now()), max_attempts: 3,
      idempotency_key: `aeo:${project.id}:${nextBucket}`,
      workspace_id: project.workspace_id, project_id: project.id,
    });
    next = { job_id: out.job?.id || null, duplicate: Boolean(out.duplicate), available_at: out.job?.available_at || null };
  }
  return { project_id: project.id, counts: run.counts, next_scheduled: next };
}