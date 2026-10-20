// Executable certification for end-to-end observability.
//
// Proves the properties the tracing layer claims, against the REAL shared modules and real
// records — not mocks:
//   1. one trace id per top-level operation, minted at enqueue and carried, never regenerated;
//   2. a retry is a further ATTEMPT of the same trace, not a new operation;
//   3. correlation crosses subsystem boundaries (run → tool → MCP → function → job → frontend);
//   4. the trail is reconstructable in order, with failures surfaced;
//   5. NO secret, token or credential can reach a span or a runtime-error report;
//   6. diagnostic reads are project-scoped — another project's trace resolves to nothing;
//   7. a runtime-error loop is folded into one row with an occurrence count.
// Every fixture is scratch data, deleted at the end.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { newTraceId, newSpanId, recordSpan, scrub, scrubText, ensureRunTrace, persistRuntimeError, diagnosticTrail, listTraces } from "../../shared/tracing.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  const scratch = `trace_test_${crypto.randomUUID().slice(0, 8)}`;
  let project = null, other = null, workspace = null, run = null;

  try {
    workspace = await svc.entities.Workspace.create({ name: `${scratch}_ws`, owner_id: "test_owner" });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${scratch}_a`, version_count: 3 });
    other = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${scratch}_b` });

    // --- 1. one trace id, minted once, back-filled once, then stable -------------------
    run = await svc.entities.AIRun.create({ project_id: project.id, status: "QUEUED", mode: "default", phase: "plan", prompt: "trace test" });
    h.check("run starts without a trace when created directly", !run.trace_id, `trace_id=${run.trace_id || "none"}`);
    const first = await ensureRunTrace(svc, run);
    const second = await ensureRunTrace(svc, { ...(await svc.entities.AIRun.get(run.id)) });
    h.check("ensureRunTrace back-fills exactly one id and reuses it", !!first && first === second, `${first} === ${second}`);

    const trace_id = first;
    const phaseSpan = newSpanId();

    // --- 2. phases + retries share the trace, differing only by attempt ---------------
    await recordSpan(svc, { trace_id, span_id: phaseSpan, workspace_id: workspace.id, project_id: project.id, run_id: run.id, event_type: "ai_run_phase", name: "plan", status: "ok", attempt: 1, duration_ms: 12 });
    await recordSpan(svc, { trace_id, parent_span_id: phaseSpan, workspace_id: workspace.id, project_id: project.id, run_id: run.id, event_type: "tool_call", name: "write_file", status: "ok", attempt: 1, duration_ms: 3 });
    await recordSpan(svc, { trace_id, workspace_id: workspace.id, project_id: project.id, run_id: run.id, event_type: "ai_run_phase", name: "build", status: "error", attempt: 1, error: new Error("2 error(s)"), error_code: "PHASE_FAILED", duration_ms: 40 });
    await recordSpan(svc, { trace_id, workspace_id: workspace.id, project_id: project.id, run_id: run.id, event_type: "ai_run_phase", name: "build", status: "ok", attempt: 2, duration_ms: 55 });

    // --- 3. cross-boundary records carrying the SAME trace ----------------------------
    const mcp = await svc.entities.MCPInvocation.create({ workspace_id: workspace.id, project_id: project.id, run_id: run.id, trace_id, connection_name: `${scratch}_conn`, tool_name: "search", ok: false, error_code: "MCP_TIMEOUT", error_message: "host did not respond", duration_ms: 20000 });
    const fn = await svc.entities.FunctionInvocation.create({ project_id: project.id, function_name: "sendReport", trigger: "test", method: "POST", status: 500, ok: false, trace_id, run_id: run.id, error_class: "DatabaseError", error_message: "relation missing", duration_ms: 9 });
    const job = await svc.entities.BackgroundJob.create({ queue: "builds", job_type: "platform.invoke_function", status: "succeeded", trace_id, project_id: project.id, workspace_id: workspace.id, attempts: 2, attempt_log: [{ attempt: 1, code: "WORKER_LOST", at: new Date().toISOString() }], duration_ms: 900 });

    // --- 4. secrets can NEVER enter the trail ----------------------------------------
    const token = "sk_live_51ABCdefGHIjklMNOpqrSTUvwx";
    const scrubbed = scrub({ api_key: "supersecretvalue", nested: { authorization: "Bearer abc.def.ghi" }, note: `charge failed with ${token}`, count: 4 });
    h.check("credential-named fields are dropped", scrubbed.api_key === "[REDACTED]" && scrubbed.nested.authorization === "[REDACTED]", JSON.stringify(scrubbed).slice(0, 160));
    h.check("credential-shaped values are redacted anywhere", !scrubbed.note.includes(token) && scrubbed.count === 4, scrubbed.note);
    h.check("scrubText redacts a leaked key in an error message", !scrubText(`boom ${token}`).includes(token), scrubText(`boom ${token}`));

    const secretSpan = await recordSpan(svc, { trace_id, workspace_id: workspace.id, project_id: project.id, run_id: run.id, event_type: "function_exec", name: "leaky", status: "error", error: new Error(`upstream rejected ${token}`), error_code: "UPSTREAM", metadata: { access_token: token, host: "api.example.com" } });
    const storedSpan = JSON.stringify(secretSpan || {});
    h.check("no secret reaches a persisted span", !storedSpan.includes(token), storedSpan.slice(0, 200));

    // --- 5. frontend runtime errors: persisted, correlated, scrubbed, folded ---------
    const report = { kind: "render_error", message: `Cannot read properties of undefined (token=${token})`, stack: `at Page (src/pages/Home.js:12:5)\nsecret=${token}`, file: "src/pages/Home.js", line: 12, column: 5, route: "/dashboard", user_agent: "Mozilla/5.0", metadata: { api_key: token, props: 3 } };
    const one = await persistRuntimeError(svc, { project, workspace_id: workspace.id, report, trace_id, run_id: run.id });
    const stored = JSON.stringify(one.runtime_error);
    h.check("runtime error is persisted and correlated", one.runtime_error.trace_id === trace_id && one.runtime_error.project_id === project.id, `trace=${one.runtime_error.trace_id}`);
    h.check("no secret reaches a persisted runtime error", !stored.includes(token), stored.slice(0, 200));
    h.check("version context is resolved server-side", one.runtime_error.version_number === 3, String(one.runtime_error.version_number));

    const two = await persistRuntimeError(svc, { project, workspace_id: workspace.id, report, trace_id, run_id: run.id });
    const three = await persistRuntimeError(svc, { project, workspace_id: workspace.id, report, trace_id, run_id: run.id });
    h.check("an error loop folds into one row with a count", two.folded && three.folded && three.runtime_error.id === one.runtime_error.id && three.runtime_error.occurrences === 3, `occurrences=${three.runtime_error.occurrences}`);

    // --- 6. the trail reconstructs the whole operation, in order ---------------------
    const trail = await diagnosticTrail(svc, { trace_id, project_id: project.id });
    const sources = new Set(trail.entries.map((e) => e.source));
    for (const src of ["TraceEvent", "AIRun", "MCPInvocation", "FunctionInvocation", "BackgroundJob", "RuntimeError"]) {
      h.check(`trail includes ${src}`, sources.has(src), [...sources].join(", "));
    }
    h.check("trail is chronologically ordered", trail.entries.every((e, i) => i === 0 || trail.entries[i - 1].at <= e.at), `${trail.entry_count} entries`);
    h.check("trail reports failure when any boundary failed", trail.status === "error" && trail.failures.length >= 3, `status=${trail.status}, failures=${trail.failures.length}`);
    h.check("retries surface as attempts of one trace", trail.attempts >= 2, `attempts=${trail.attempts}`);
    h.check("references point at the authoritative records", trail.entries.some((e) => e.record_id === mcp.id) && trail.entries.some((e) => e.record_id === fn.id) && trail.entries.some((e) => e.record_id === job.id), "mcp/function/job present");
    h.check("trail carries no secret", !JSON.stringify(trail).includes(token), "clean");

    // --- 7. project isolation --------------------------------------------------------
    const foreign = await diagnosticTrail(svc, { trace_id, project_id: other.id });
    h.check("a trace cannot be read from another project", foreign.entry_count === 0, `entries=${foreign.entry_count}`);
    await h.expectThrow("a trail read without a project is refused", () => diagnosticTrail(svc, { trace_id }), "INVALID_INPUT");
    const listed = await listTraces(svc, { project_id: project.id });
    h.check("recent traces list the operation", listed.some((t) => t.trace_id === trace_id && t.errors > 0), `${listed.length} trace(s)`);
    const otherList = await listTraces(svc, { project_id: other.id });
    h.check("trace list is project-scoped", otherList.length === 0, `${otherList.length} trace(s)`);

    // --- 8. ids are unique -----------------------------------------------------------
    h.check("trace/span ids are unique", newTraceId() !== newTraceId() && newSpanId() !== newSpanId(), "unique");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of [project?.id, other?.id].filter(Boolean)) {
      await purgeBy(svc, "TraceEvent", { project_id: p });
      await purgeBy(svc, "RuntimeError", { project_id: p });
      await purgeBy(svc, "MCPInvocation", { project_id: p });
      await purgeBy(svc, "FunctionInvocation", { project_id: p });
      await purgeBy(svc, "BackgroundJob", { project_id: p });
      await purgeBy(svc, "AIRun", { project_id: p });
      await svc.entities.Project.delete(p).catch(() => {});
    }
    if (workspace) await svc.entities.Workspace.delete(workspace.id).catch(() => {});
  }
}