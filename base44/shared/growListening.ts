// Runable Grow — Phase 4: NexusAI-native social listening.
//
// The smallest listening capability the existing certified infrastructure supports:
//   • TERMS: bounded company/competitor phrases per project (max 10 terms rows, 1-5 phrases each),
//     idempotent to re-add (the same (label, kind) returns the existing row);
//   • COLLECTION: the ONLY supported public source is the app's own web-search adapter
//     (shared/webSearch.ts, Tavily first) — one bounded search per term. NO platform
//     connector is used for listening: Facebook/Instagram/LinkedIn publishing connectors
//     expose publishing scopes, not read/search APIs, and inventing a read adapter over them
//     would fabricate undocumented credentials/event behavior. Other sources are UNKNOWN.
//   • NORMALIZATION: every result is scrubbed/bounded exactly like the agent observation path;
//   • DEDUP: deterministic per-(term, result) keys (url-based when present, title otherwise) —
//     two runs over the same public result can never produce two rows;
//   • REPORT: computed ONLY from stored rows — windowed counts, per-term shares, top URLs;
//   • SCHEDULING: the certified job queue (no second scheduler). A monitoring run is ONE
//     idempotent BackgroundJob per interval bucket; the executor self-reschedules the next
//     bucket while active terms remain, so removing every term stops the chain naturally.
//     The default interval is NEXUSAI-DERIVED (the documented monitoring cadence is UNKNOWN).
//
// Fail-open per term, fail-closed per run: one term's search failure (provider error,
// timeout, not-configured) is RECORDED as that term's status and never fails the whole run;
// only structural problems (project gone) fail the job. Zero real side effects: the search
// seam is injectable for certification (production never passes one).

import { err } from "./virality.ts";
import { runWebSearch } from "./webSearch.ts";
import { enqueue } from "./jobQueue.ts";

export const LISTEN_JOB_TYPE = "grow.listen";
export const MAX_TERMS = 10;
export const MAX_PHRASES_PER_TERM = 5;
export const DEFAULT_INTERVAL_MINUTES = 360; // NEXUSAI-DERIVED (UNKNOWN): the documented cadence is not published

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const nowIso = () => new Date().toISOString();

/** Deterministic bounded key for one (term, result) pair. */
const hashKey = (s) => {
  let h = 5381;
  for (const ch of String(s)) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
  return h.toString(16);
};

export const projectTerm = (t) => ({ id: t.id, label: t.label, kind: t.kind, terms: t.terms || [], status: t.status || "active" });

export async function addTerm(svc, project, workspace, input) {
  const label = clean(input.label, 120);
  if (!label) throw err("label is required", 400, "LABEL_REQUIRED");
  const kind = input.kind === "competitor" ? "competitor" : "company";
  const phrases = (Array.isArray(input.terms) ? input.terms : []).map((t) => clean(t, 60)).filter(Boolean);
  if (!phrases.length) throw err("terms is required — at least one search phrase", 400, "TERMS_REQUIRED");
  if (phrases.length > MAX_PHRASES_PER_TERM) throw err(`At most ${MAX_PHRASES_PER_TERM} phrases per term`, 422, "TOO_MANY_PHRASES");
  const existing = await svc.entities.ListenTerm.filter({ project_id: project.id, label, kind }, "created_date", 1);
  const same = existing[0];
  if (same) return { deduped: true, term: projectTerm(same) };
  if (await svc.entities.ListenTerm.count({ project_id: project.id, status: "active" }) >= MAX_TERMS) {
    throw err(`At most ${MAX_TERMS} terms per project`, 422, "TOO_MANY_TERMS");
  }
  const row = await svc.entities.ListenTerm.create({ project_id: project.id, workspace_id: workspace.id, label, kind, terms: phrases, status: "active" });
  return { deduped: false, term: projectTerm(row) };
}

export async function removeTerm(svc, project, term_id) {
  const row = (await svc.entities.ListenTerm.filter({ id: term_id }, "created_date", 1))[0] || null;
  if (!row || row.project_id !== project.id) throw err("The term is not in this project", 404, "TERM_NOT_FOUND");
  await svc.entities.ListenTerm.delete(row.id);
  return { removed: term_id };
}

export async function listTerms(svc, project) {
  const rows = await svc.entities.ListenTerm.filter({ project_id: project.id }, "created_date", MAX_TERMS * 2).catch(() => []);
  return { terms: rows.map(projectTerm) };
}

/** One bounded monitoring run over the project's active terms. Per-term statuses; never throws
 *  for a search failure. `opts.search` is the certification seam (production never passes one). */
export async function runMonitor(svc, project, workspace, { search = null, trigger = "manual" } = {}) {
  const doSearch = search || (async ({ query }) => runWebSearch({ query }));
  const terms = await svc.entities.ListenTerm.filter({ project_id: project.id, status: "active" }, "created_date", MAX_TERMS);
  if (!terms.length) return { trigger, terms: [], counts: { searched: 0, inserted: 0, duplicates: 0 }, term_results: [] };

  const seenKeys = new Set();
  const createdRows = [];
  const termResults = [];
  for (const term of terms) {
    const res = await doSearch({ query: (term.terms || []).join(" ") }).catch((e) => ({ ok: false, code: "LISTEN_PROVIDER_ERROR", message: clean(e?.message || e, 200) }));
    if (!res?.ok) {
      termResults.push({ term_id: term.id, label: term.label, status: "error", code: res?.code || "LISTEN_PROVIDER_ERROR" });
      continue;
    }
    let inserted = 0, duplicates = 0;
    for (const r of (res.results || [])) {
      const dedup_key = `${term.id}:${r.url ? `u:${hashKey(r.url)}` : `t:${hashKey(r.title || "")}`}`;
      if (seenKeys.has(dedup_key) || await svc.entities.ListenObservation.count({ project_id: project.id, dedup_key })) { duplicates++; continue; }
      seenKeys.add(dedup_key);
      createdRows.push({
        project_id: project.id, workspace_id: workspace?.id || project.workspace_id,
        term_id: term.id, term_label: term.label, source: res.provider || "web_search",
        title: clean(r.title, 200), url: clean(r.url, 500), snippet: clean(r.content, 500),
        dedup_key, observed_at: nowIso(),
      });
      inserted++;
    }
    termResults.push({ term_id: term.id, label: term.label, status: "ok", inserted, duplicates });
  }
  const stored = createdRows.length ? await svc.entities.ListenObservation.bulkCreate(createdRows.slice(0, 100)) : [];
  const counts = {
    searched: terms.length,
    inserted: (stored || []).length,
    duplicates: termResults.reduce((n, t) => n + (t.duplicates || 0), 0),
  };
  return { trigger, counts, terms: termResults.map((t) => ({ label: t.label, status: t.status, ...(t.status === "ok" ? { inserted: t.inserted, duplicates: t.duplicates } : { code: t.code }) })) };
}

/** The deterministic report: computed ONLY from stored observations, windowed. */
export async function buildReport(svc, project, { since_days = 7 } = {}) {
  const days = Math.max(1, Math.min(90, Number(since_days) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const query = { project_id: project.id, observed_at: { $gte: since } };
  const [total, groups] = await Promise.all([
    svc.entities.ListenObservation.count(query),
    svc.entities.ListenObservation.aggregate({ query, groupBy: ["term_label", "url"], max: "observed_at", sort: "-count", limit: 1000 }),
  ]);
  const byTerm = new Map();
  for (const row of groups.rows || []) {
    const g = byTerm.get(row.term_label) || { label: row.term_label, count: 0, top_urls: [], last_seen: "" };
    g.count += row.count;
    if (row.url && g.top_urls.length < 3) g.top_urls.push(row.url);
    if (row.max_observed_at > g.last_seen) g.last_seen = row.max_observed_at;
    byTerm.set(row.term_label, g);
  }
  return { generated_at: nowIso(), window_days: days, total_observations: total, truncated: !!groups.truncated,
    terms: [...byTerm.values()].map((g) => ({ ...g, share: total ? Math.round(g.count / total * 100) / 100 : 0 })).sort((a, b) => b.count - a.count) };
}

const clampInterval = (v) => Math.max(30, Math.min(10080, Number(v) || DEFAULT_INTERVAL_MINUTES));

/** ONE idempotent monitoring job per interval bucket (the queue's dedup; no second scheduler). */
export async function scheduleMonitoring(svc, project, workspace, { interval_minutes } = {}) {
  const interval = clampInterval(interval_minutes);
  const bucket = Math.floor(Date.now() / (interval * 60000)) * (interval * 60000);
  const res = await enqueue(svc, {
    queue: "default", job_type: LISTEN_JOB_TYPE,
    payload: { project_id: project.id, interval_minutes: interval },
    delay_ms: 0, max_attempts: 3,
    idempotency_key: `listen:${project.id}:${bucket}`,
    workspace_id: workspace.id, project_id: project.id,
  });
  return { interval_minutes: interval, job_id: res.job?.id || null, duplicate: Boolean(res.duplicate), next_run_at: res.job?.available_at || null };
}

/** The queued monitoring job: run the monitor, then keep the chain alive while terms remain. */
export async function executeListenMonitorJob(svc, { project_id, interval_minutes }, { search = null } = {}) {
  const project = await svc.entities.Project.get(String(project_id || "")).catch(() => null);
  if (!project) throw Object.assign(new Error("the project no longer exists"), { retryable: false, code: "INVALID_PAYLOAD" });
  const interval = clampInterval(interval_minutes);
  const run = await runMonitor(svc, project, null, { search, trigger: "scheduled" });
  const active = (await svc.entities.ListenTerm.filter({ project_id: project.id, status: "active" }, "created_date", 1).catch(() => []));
  let next = null;
  if (active.length) {
    const nextBucket = Math.floor((Date.now() + interval * 60000) / (interval * 60000)) * (interval * 60000);
    const out = await enqueue(svc, {
      queue: "default", job_type: LISTEN_JOB_TYPE,
      payload: { project_id: project.id, interval_minutes: interval },
      delay_ms: Math.max(60000, nextBucket - Date.now()), max_attempts: 3,
      idempotency_key: `listen:${project.id}:${nextBucket}`,
      workspace_id: project.workspace_id, project_id: project.id,
    });
    next = { job_id: out.job?.id || null, duplicate: Boolean(out.duplicate), available_at: out.job?.available_at || null };
  }
  return { project_id: project.id, counts: run.counts, terms: run.terms, next_scheduled: next };
}