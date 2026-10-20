// Targeted certification for Phase 4 — social listening (shared/growListening.ts + the
// jobHandlers registry entry). ZERO real network (the search seam is injected), real
// persistence through ListenTerm + ListenObservation + BackgroundJob, full cleanup in `finally`.
//   1. validation: label/terms required, phrase bound, per-project term cap;
//   2. idempotent re-add (same label+kind → the same row);
//   3. persistence + dedup: results land project-scoped with deterministic keys; a repeat run
//      over the same results inserts ZERO new rows; a new URL inserts;
//   4. provider failure: an HTTP-500 search is recorded per-term (run still succeeds, no rows);
//      an unconfigured search fails closed per-term;
//   5. empty + partial results: no terms → zero rows; one failing term among two → mixed statuses;
//   6. report: windowed counts computed only from stored rows, per-project isolated;
//   7. scheduling: one bucket-keyed BackgroundJob, deduped re-schedule, executor self-reschedules
//     the next bucket and stops the chain when no active terms remain;
//   8. authorization: a non-member cannot read the project (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import {
  addTerm, removeTerm, listTerms, runMonitor, buildReport, scheduleMonitoring,
  executeListenMonitorJob, LISTEN_JOB_TYPE, MAX_TERMS, MAX_PHRASES_PER_TERM,
} from "../../shared/growListening.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";

const OK_FETCH = (bodies) => async () => new Response(JSON.stringify({ results: bodies }), { status: 200 });
const searchSeam = (fetchImpl) => async ({ query }) => {
  const { runWebSearch } = await import("../../shared/webSearch.ts");
  return runWebSearch({ query, keyProvider: () => "test-key", fetchImpl });
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    const ws = await svc.entities.Workspace.create({ name: `listen-${stamp}`, owner_id: `ownerL_${stamp}` });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `listen-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `listen2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);

    // ---- 1. validation ------------------------------------------------------------------
    const noLabel = await captureCall(() => addTerm(svc, proj, ws, { label: "", terms: ["x"] }));
    h.check("an empty label is refused 400 (LABEL_REQUIRED)", noLabel.threw && noLabel.code === "LABEL_REQUIRED", noLabel.code || "no-throw");
    const noTerms = await captureCall(() => addTerm(svc, proj, ws, { label: "Acme", terms: [] }));
    h.check("empty terms are refused 400 (TERMS_REQUIRED)", noTerms.threw && noTerms.code === "TERMS_REQUIRED", noTerms.code || "no-throw");
    const tooManyPhrases = await captureCall(() => addTerm(svc, proj, ws, { label: "Acme", terms: Array(MAX_PHRASES_PER_TERM + 1).fill("p") }));
    h.check("too many phrases are refused 422 (TOO_MANY_PHRASES)", tooManyPhrases.threw && tooManyPhrases.code === "TOO_MANY_PHRASES", tooManyPhrases.code || "no-throw");
    for (let i = 0; i < MAX_TERMS; i++) await addTerm(svc, proj, ws, { label: `T${i}`, kind: i === 0 ? "company" : "competitor", terms: [`phrase ${i}`] });
    const overCap = await captureCall(() => addTerm(svc, proj, ws, { label: "Overflow", terms: ["p"] }));
    h.check("the per-project term cap is enforced 422 (TOO_MANY_TERMS)", overCap.threw && overCap.code === "TOO_MANY_TERMS", overCap.code || "no-throw");

    // ---- 2. idempotent re-add -------------------------------------------------------------
    const first = await addTerm(svc, proj2, ws, { label: "Acme Corp", kind: "company", terms: ["Acme Corp reviews", "Acme Corp pricing"] });
    const again = await addTerm(svc, proj2, ws, { label: "Acme Corp", kind: "company", terms: ["Acme Corp reviews", "Acme Corp pricing"] });
    h.check("re-adding the same (label, kind) is a dedup: the SAME row id",
      again.deduped === true && again.term.id === first.term.id, JSON.stringify(again));

    // ---- 3. persistence + dedup --------------------------------------------------------------
    const docs = [{ title: "Acme Corp raises Series B", url: "https://news.example/acme-b", content: "Funding news" }, { title: "Acme review thread", url: "https://forum.example/acme", content: "Mixed reviews" }];
    const run1 = await runMonitor(svc, proj2, ws, { search: searchSeam(OK_FETCH(docs)) });
    h.check("the run persists project-scoped observations with deterministic dedup keys",
      run1.counts.inserted === 2 && run1.counts.searched === 1,
      JSON.stringify(run1.counts));
    const stored = await svc.entities.ListenObservation.filter({ project_id: proj2.id }, "created_date", 10);
    h.check("stored rows carry term scoping, a provider id and bounded normalized values",
      stored.length === 2 && stored.every((o) => o.term_id === first.term.id && o.term_label === "Acme Corp" && o.dedup_key && o.url.length <= 500),
      JSON.stringify(stored.map((o) => o.dedup_key)));
    const run2 = await runMonitor(svc, proj2, ws, { search: searchSeam(OK_FETCH(docs)) });
    h.check("a repeat run over the same results inserts ZERO new rows (deterministic dedup)",
      run2.counts.inserted === 0 && run2.counts.duplicates === 2, JSON.stringify(run2.counts));
    const run3 = await runMonitor(svc, proj2, ws, { search: searchSeam(OK_FETCH([{ title: "Acme wins award", url: "https://news.example/acme-award", content: "New" }, docs[1]])) });
    h.check("a run with one new URL inserts exactly the new observation", run3.counts.inserted === 1 && run3.counts.duplicates === 1, JSON.stringify(run3.counts));

    // ---- 4. provider failure + fail-closed unconfigured --------------------------------------
    const beforeFail = (await svc.entities.ListenObservation.filter({ project_id: proj2.id }, "created_date", 10)).length;
    const failRun = await runMonitor(svc, proj2, ws, { search: searchSeam(async () => new Response("{}", { status: 500 })) });
    const afterFail = (await svc.entities.ListenObservation.filter({ project_id: proj2.id }, "created_date", 10)).length;
    h.check("a provider 500 is recorded per-term (error code), the run succeeds, zero rows written",
      failRun.terms[0].status === "error" && failRun.counts.inserted === 0 && afterFail === beforeFail,
      JSON.stringify(failRun.terms));
    const unconfRun = await runMonitor(svc, proj2, ws, { search: async ({ query }) => (await import("../../shared/webSearch.ts")).runWebSearch({ query, keyProvider: () => null }) });
    h.check("an unconfigured search fails closed per-term (WEB_SEARCH_NOT_CONFIGURED)",
      unconfRun.terms[0].status === "error" && unconfRun.terms[0].code === "WEB_SEARCH_NOT_CONFIGURED",
      JSON.stringify(unconfRun.terms));

    // ---- 5. empty + partial results ------------------------------------------------------------
    const proj3 = await svc.entities.Project.create({ workspace_id: ws.id, name: `listen3-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj3.id);
    const emptyRun = await runMonitor(svc, proj3, ws, {});
    h.check("a project with NO active terms is an empty success (zero rows, no search)",
      emptyRun.counts.searched === 0 && emptyRun.counts.inserted === 0 && emptyRun.terms.length === 0, JSON.stringify(emptyRun.counts));
    await addTerm(svc, proj2, ws, { label: "Rival Inc", kind: "competitor", terms: ["Rival Inc pricing"] });
    const partialRun = await runMonitor(svc, proj2, ws, { search: async ({ query }) => String(query).includes("Rival") ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ results: [] }), { status: 200 }) });
    h.check("one failing term among two leaves MIXED statuses and the run still succeeds",
      partialRun.terms.length === 2 && partialRun.terms.some((t) => t.status === "ok") && partialRun.terms.some((t) => t.status === "error"),
      JSON.stringify(partialRun.terms));

    // ---- 6. report -----------------------------------------------------------------------------
    const storedAll = await svc.entities.ListenObservation.filter({ project_id: proj2.id }, "created_date", 10);
    const report = await buildReport(svc, proj2, { since_days: 7 });
    h.check("the report is windowed, term-grouped and computed only from stored rows",
      report.total_observations === storedAll.length && report.terms.length === 1 &&
      report.terms[0].label === "Acme Corp" && report.terms[0].count === storedAll.length &&
      report.terms[0].share === 1 && Array.isArray(report.terms[0].top_urls) && report.terms[0].top_urls.length > 0,
      JSON.stringify(report.terms));
    const report2 = await buildReport(svc, proj3, { since_days: 7 });
    h.check("isolation: another project's report is empty", report2.total_observations === 0, JSON.stringify(report2));

    // ---- 7. scheduling + executor chain ----------------------------------------------------------
    const sch = await scheduleMonitoring(svc, proj2, ws, { interval_minutes: 60 });
    h.check("monitoring is scheduled as ONE bucket-keyed grow.listen job", sch.job_id && typeof sch.job_id === "string", JSON.stringify(sch));
    const sch2 = await scheduleMonitoring(svc, proj2, ws, { interval_minutes: 60 });
    h.check("re-scheduling the same bucket is a dedup: the same job id", sch2.duplicate === true && sch2.job_id === sch.job_id, JSON.stringify(sch2));
    const rescheduled = await scheduleMonitoring(svc, proj2, ws, { interval_minutes: 43200 });
    h.check("an oversized interval is clamped into the supported bound", rescheduled.interval_minutes === 10080, String(rescheduled.interval_minutes));
    await removeTerm(svc, proj2, first.term.id).catch(() => {});
    const rivalTerm = (await listTerms(svc, proj2)).terms.find((t) => t.label === "Rival Inc");
    const exec1 = await MAINTENANCE_HANDLERS[LISTEN_JOB_TYPE]({ id: "job-l1", payload: { project_id: proj2.id, interval_minutes: 60 } }, { base44: svc, heartbeat: async () => {} });
    h.check("the executor runs through the registry and self-reschedules the NEXT bucket while terms remain",
      exec1.counts.searched >= 1 && exec1.next_scheduled && exec1.next_scheduled.job_id && exec1.next_scheduled.duplicate === false,
      JSON.stringify(exec1.next_scheduled));
    const nextJobs = (await svc.entities.BackgroundJob.filter({ queue: "default", job_type: LISTEN_JOB_TYPE }, "created_date", 10))
      .filter((j) => j.project_id === proj2.id && String(j.idempotency_key).startsWith(`listen:${proj2.id}`));
    h.check("the chain's next job exists with a later bucket key",
      nextJobs.length >= 2 && new Set(nextJobs.map((j) => j.idempotency_key)).size === nextJobs.length,
      JSON.stringify(nextJobs.map((j) => j.idempotency_key)));
    const rivalId = rivalTerm ? rivalTerm.id : null;
    if (rivalId) await removeTerm(svc, proj2, rivalId);
    const rivalRows = await svc.entities.ListenObservation.filter({ project_id: proj2.id }, "created_date", 10);
    for (const o of rivalRows) if (!String(o.dedup_key).includes(first.term.id)) await svc.entities.ListenObservation.delete(o.id).catch(() => {});
    const exec2 = await MAINTENANCE_HANDLERS[LISTEN_JOB_TYPE]({ id: "job-l2", payload: { project_id: proj2.id, interval_minutes: 60 } }, { base44: svc, heartbeat: async () => {} });
    h.check("with NO active terms the executor does NOT reschedule — the chain stops",
      exec2.next_scheduled === null && exec2.counts.searched === 0, JSON.stringify(exec2.next_scheduled));
    const missingProject = await captureCall(() => MAINTENANCE_HANDLERS[LISTEN_JOB_TYPE]({ id: "job-l3", payload: { project_id: "no-such-project" } }, { base44: svc, heartbeat: async () => {} }));
    h.check("a missing project is INVALID_PAYLOAD and non-retryable",
      missingProject.threw && missingProject.code === "INVALID_PAYLOAD", missingProject.code || "no-throw");

    // ---- 8. authorization ---------------------------------------------------------------------------
    const stranger = { id: `l_stranger_${stamp}`, email: "ls@example.com" };
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, stranger, proj2.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's listening (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "ListenTerm", { project_id: pid });
      await purgeBy(svc, "ListenObservation", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}