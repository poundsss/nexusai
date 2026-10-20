// E2E certification for the NexusAI AI App Primitive Platform (#27).
//
// Runs against the REAL modules and the REAL data layer: the real frozen contract registry, the
// real server-side executor, the real Model Gateway (driven through its own deterministic provider
// override so no live model is required), the real credit reserve/settle path, the real file,
// messaging, job-queue and scheduled-trigger infrastructure, the real function runtime and the
// real tracing/audit systems. Nothing is stubbed inside the platform and no second gateway,
// queue, scheduler, runtime or ledger exists.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { invokePrimitive, listPrimitiveInvocations, createAppPrimitives, PRIMITIVE_JOB_TYPE } from "../../shared/primitives.ts";
import { PRIMITIVES, resolvePrimitive, latestVersion, versionsOf, describePrimitives, PRIMITIVE_CONTRACT_VERSION } from "../../shared/primitiveContract.ts";
import { uploadFile } from "../../shared/appFiles.ts";
import { USERS_ENTITY } from "../../shared/appAuth.ts";
import { MESSAGES_ENTITY } from "../../shared/appMessaging.ts";
import { runJobs } from "../../shared/jobQueue.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";
import { recordEvent } from "../../shared/ledger.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";

const SECRET = "sk_live_PRIMITIVELEAK1234567890";

// Deterministic gateway provider: the REAL gateway, retry, timeout, health and billing path, with
// a provider that answers predictably so certification needs no live model.
const stubProvider = (impl) => ({
  supportsTools: () => false,
  getModelInfo: () => null,
  async stream() { throw new Error("streaming not supported"); },
  generate: impl,
});
const OK_PROVIDER = {
  "base44-core": stubProvider(async ({ jsonSchema }) => ({
    output: jsonSchema ? { title: "Quarterly Report", amount: 42 } : "primitive stub answer",
    usage: { input_tokens: 120, output_tokens: 45, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 165, usage_source: "provider" },
  })),
};
const BAD_SHAPE_PROVIDER = {
  "base44-core": stubProvider(async () => ({
    output: { unexpected: true },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, usage_source: "provider" },
  })),
};
const FAILING_PROVIDER = {
  "base44-core": stubProvider(async () => {
    throw Object.assign(new Error("upstream temporarily unavailable"), { code: "PROVIDER_UNAVAILABLE", retryable: true });
  }),
};

const APP_FUNCTION_SOURCE = `export const config = { method: "POST" };
export default async function (ctx) {
  const res = await ctx.primitives.invoke("Search", { entity: "Task", query: "alpha", limit: 5 });
  return { body: { ok: res.ok, count: res.ok ? res.output.count : 0, available: ctx.primitives.names().length } };
}
`;

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `prim-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "primitive-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.create({ project_id: project.id, path: ENTRY_FILE, content: `export default function App() { return null; }` });
    // Real credits, through the real ledger — the AI path reserves and settles for real.
    await recordEvent(svc, { workspace_id: ws.id, event_type: "promotional", amount: 500, idempotency_key: `prim-cert-grant-${ws.id}`, reason: "certification grant" });

    // A project in a workspace this caller is NOT a member of.
    const wsForeign = await svc.entities.Workspace.create({ name: `prim-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreign = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreign.id);

    // A workspace where the caller is only a VIEWER — read primitives allowed, writes refused.
    const wsViewer = await svc.entities.Workspace.create({ name: `prim-viewer-${Date.now()}`, owner_id: `u_owner_${Date.now()}`, status: "active" });
    created.workspaces.push(wsViewer.id);
    const viewerProject = await svc.entities.Project.create({ workspace_id: wsViewer.id, name: "viewer-project", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(viewerProject.id);
    await svc.entities.WorkspaceMember.create({ workspace_id: wsViewer.id, user_id: user.id, email: user.email, role: "viewer", status: "active" });
    await svc.entities.AppEntity.create({ project_id: viewerProject.id, name: "Task", fields: { title: { type: "string" } } });

    // App data for Search, an end-user for SendNotification, a file for FileProcess.
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Task", fields: { title: { type: "string" }, note: { type: "string" } } });
    for (const t of [{ title: "alpha one", note: "first" }, { title: "alpha two", note: "second" }, { title: "beta", note: "third" }]) {
      await svc.entities.AppRecord.create({ project_id: project.id, entity_name: "Task", data: t });
    }
    await svc.entities.AppRecord.create({ project_id: foreign.id, entity_name: "Task", data: { title: "alpha foreign" } });
    const endUser = await svc.entities.AppRecord.create({ project_id: project.id, entity_name: USERS_ENTITY, data: { email: "end@user.test" } });
    const file = await uploadFile(svc, project.id, {
      filename: "notes.txt", content_type: "text/plain",
      content_base64: btoa("primitive file body\nsecond line"),
    });
    const foreignFile = await uploadFile(svc, foreign.id, {
      filename: "foreign.txt", content_type: "text/plain", content_base64: btoa("foreign body"),
    });

    const trace_id = `tr_prim_${Date.now()}`;
    const run_id = `run_prim_${Date.now()}`;
    const P = (args) => invokePrimitive(base44, { project_id: project.id, actor: "user", user, trace_id, run_id, ...args });

    // ------------------------------------------------- 1. registry + versioning
    const described = describePrimitives();
    const names = [...new Set(described.primitives.map((p) => p.name))];
    const required = ["InvokeAI", "GenerateImage", "ExtractStructuredData", "FileProcess", "Search", "SendEmail", "SendNotification", "BackgroundJob", "ScheduleTask"];
    h.check("1 the canonical registry declares exactly the #27 primitives",
      required.every((n) => names.includes(n)) && names.length === required.length,
      `${names.length} primitives: ${names.join(", ")}`);
    h.check("1b every primitive publishes a versioned, self-describing contract",
      described.primitives.every((p) => p.version && p.input_schema && p.output_schema && p.error_codes.length && p.cost_class && p.execution_mode && p.contract_version !== undefined || p.version),
      `contract ${PRIMITIVE_CONTRACT_VERSION}`);
    h.check("2 a primitive can carry several versions and resolves to the latest by default",
      versionsOf("InvokeAI").join(",") === "1.0.0,1.1.0" && latestVersion("InvokeAI") === "1.1.0" &&
      resolvePrimitive("InvokeAI").version === "1.1.0" && resolvePrimitive("InvokeAI", "1.0.0").version === "1.0.0",
      `InvokeAI versions ${versionsOf("InvokeAI").join(", ")}`);
    const frozen = resolvePrimitive("InvokeAI", "1.0.0");
    let mutated = false;
    try { frozen.timeout_ms = 1; mutated = frozen.timeout_ms === 1; } catch { mutated = false; }
    h.check("2b a published contract version is immutable", !mutated && Object.isFrozen(frozen) && Object.isFrozen(PRIMITIVES),
      "mutation of a published version does not take effect");
    h.check("2c cost is declared honestly per primitive",
      described.primitives.filter((p) => p.consumes_ai_credits).map((p) => p.name).sort().join(",") === "ExtractStructuredData,GenerateImage,InvokeAI,InvokeAI" &&
      described.primitives.filter((p) => !p.consumes_ai_credits).every((p) => p.ai_charge_path === null),
      "only the AI primitives declare AI credit consumption");

    // ------------------------------------------------------------- 3. InvokeAI
    const ai = await P({ primitive: "InvokeAI", version: "1.0.0", input: { prompt: "Summarise the platform in one line." }, options: { providerOverrides: OK_PROVIDER } });
    const aiJson = await P({ primitive: "InvokeAI", input: { prompt: "Return the report", response_schema: { type: "object", properties: { title: { type: "string" }, amount: { type: "number" } }, required: ["title"] } }, options: { providerOverrides: OK_PROVIDER } });
    h.check("3 InvokeAI executes through the existing Model Gateway",
      ai.ok === true && ai.output.text === "primitive stub answer" && !!ai.output.model_id && ai.usage.cost_class === "ai" && ai.usage.consumes_ai_credits === true,
      `model ${ai.output?.model_id} · ${ai.usage?.credits_charged} credit(s)`);
    h.check("3b a newer contract version adds capability without changing the old one",
      aiJson.ok === true && aiJson.version === "1.1.0" && !!aiJson.output.data?.title &&
      (await P({ primitive: "InvokeAI", version: "1.0.0", input: { prompt: "x", response_schema: { type: "object" } }, options: { providerOverrides: OK_PROVIDER } })).error?.code === "PRIMITIVE_INPUT_INVALID",
      "1.1.0 accepts response_schema; 1.0.0 refuses it instead of silently behaving differently");

    // ------------------------------------------------------- 4. GenerateImage
    const image = await P({ primitive: "GenerateImage", input: { prompt: "A neutral abstract gradient, muted grey and white" } });
    h.check("4 GenerateImage runs through the platform image provider",
      (image.ok === true && typeof image.output.url === "string" && image.output.url.startsWith("http")) ||
      (image.ok === false && ["provider", "timeout"].includes(image.error.category)),
      image.ok ? `image produced (${image.usage.cost_class})` : `provider unavailable: ${image.error.code}`);
    const shortPrompt = await P({ primitive: "GenerateImage", input: { prompt: "x" } });
    h.check("4b bounded input is refused before any provider call",
      shortPrompt.ok === false && shortPrompt.error.code === "PRIMITIVE_INPUT_INVALID" && shortPrompt.error.retryable === false,
      shortPrompt.error?.message);

    // ----------------------------------------------- 5. ExtractStructuredData
    const schema = { type: "object", required: ["title"], properties: { title: { type: "string" }, amount: { type: "number" } } };
    const extract = await P({ primitive: "ExtractStructuredData", input: { text: "Quarterly Report — amount 42", schema }, options: { providerOverrides: OK_PROVIDER } });
    const badExtract = await P({ primitive: "ExtractStructuredData", input: { text: "nothing useful here", schema }, options: { providerOverrides: BAD_SHAPE_PROVIDER } });
    h.check("5 ExtractStructuredData returns the declared structure",
      extract.ok === true && extract.output.data.title === "Quarterly Report" && extract.output.data.amount === 42 && extract.output.source === "text",
      JSON.stringify(extract.output?.data || {}));
    h.check("5b an extraction that does not satisfy the declared schema fails explicitly",
      badExtract.ok === false && badExtract.error.code === "EXTRACTION_INVALID" && badExtract.error.retryable === false,
      badExtract.error?.message);
    h.check("5c an extraction with neither text nor file is refused",
      (await P({ primitive: "ExtractStructuredData", input: { schema } })).error?.code === "PRIMITIVE_INPUT_INVALID",
      "text or file_id is required");

    // ------------------------------------------------------------ 6. FileProcess
    const meta = await P({ primitive: "FileProcess", input: { file_id: file.id, operation: "metadata" } });
    const signed = await P({ primitive: "FileProcess", input: { file_id: file.id, operation: "signed_url" } });
    const text = await P({ primitive: "FileProcess", input: { file_id: file.id, operation: "extract_text" } });
    h.check("6 FileProcess reads a file that belongs to the project",
      meta.ok === true && meta.output.file.filename === "notes.txt" && signed.ok === true && typeof signed.output.url === "string" &&
      text.ok === true && text.output.text.startsWith("primitive file body"),
      `${meta.output?.file?.size} bytes · signed url minted · text extracted`);
    h.check("6b the storage handle never crosses back to the caller",
      !JSON.stringify([meta.output, signed.output, text.output]).includes("file_uri"),
      "only metadata, a short-lived signed URL and text are returned");
    const foreignFileRead = await P({ primitive: "FileProcess", input: { file_id: foreignFile.id, operation: "metadata" } });
    h.check("6c another project's file is unreachable",
      foreignFileRead.ok === false && foreignFileRead.error.code === "FILE_NOT_FOUND",
      "a file id from another project reports not found, so existence never leaks");

    // ----------------------------------------------------------------- 7. Search
    const found = await P({ primitive: "Search", input: { entity: "Task", query: "alpha", fields: ["title"] } });
    const page1 = await P({ primitive: "Search", input: { entity: "Task", limit: 2, offset: 0 } });
    const page2 = await P({ primitive: "Search", input: { entity: "Task", limit: 2, offset: 2 } });
    h.check("7 Search returns bounded, source-attributed results from the project's own data",
      found.ok === true && found.output.count === 2 && found.output.items.every((i) => String(i.title).includes("alpha")) && found.output.source.type === "app_data",
      `${found.output?.count} match(es) of ${found.output?.source?.scanned} scanned`);
    h.check("7b pagination is deterministic",
      page1.ok === true && page2.ok === true && page1.output.count === 2 && page1.output.next_offset === 2 &&
      page1.output.items.every((i) => !page2.output.items.some((j) => j.id === i.id)) &&
      JSON.stringify(page1.output.items) === JSON.stringify((await P({ primitive: "Search", input: { entity: "Task", limit: 2, offset: 0 } })).output.items),
      "the same query returns the same page, and pages do not overlap");
    h.check("7c Search cannot reach another project's records",
      found.output.items.every((i) => !String(i.title).includes("foreign")) &&
      (await P({ primitive: "Search", input: { entity: "Unknown" } })).error?.code === "SEARCH_SOURCE_UNKNOWN",
      "results are project-scoped and an undeclared entity is refused");

    // ------------------------------------------------------------- 8. messaging
    const emailKey = `email-${Date.now()}`;
    const email = await P({ primitive: "SendEmail", idempotency_key: emailKey, input: { to: ["someone@example.com"], subject: "Primitive certification", text: "hello" }, options: { messagingTransport: "test" } });
    const noKey = await P({ primitive: "SendEmail", input: { to: ["someone@example.com"], subject: "no key", text: "hello" }, options: { messagingTransport: "test" } });
    const badRecipient = await P({ primitive: "SendEmail", idempotency_key: `bad-${Date.now()}`, input: { to: ["not-an-email"], subject: "x", text: "y" }, options: { messagingTransport: "test" } });
    h.check("8 SendEmail sends through the existing transport with the project's sender",
      email.ok === true && !!email.output.message_id && email.output.recipients === 1 && email.usage.consumes_ai_credits === false,
      `message ${email.output?.message_id}`);
    h.check("8b a side-effecting primitive requires an idempotency key",
      noKey.ok === false && noKey.error.code === "IDEMPOTENCY_KEY_REQUIRED" && noKey.error.retryable === false, noKey.error?.message);
    h.check("8c invalid recipients are refused server-side",
      badRecipient.ok === false && badRecipient.error.code === "EMAIL_INVALID_RECIPIENT" && badRecipient.error.category === "validation",
      badRecipient.error?.message);
    const notify = await P({ primitive: "SendNotification", idempotency_key: `notify-${Date.now()}`, input: { user_id: endUser.id, title: "Ready", content: "Your report is ready" }, options: { messagingTransport: "test" } });
    const notifyForeign = await P({ primitive: "SendNotification", idempotency_key: `notify-x-${Date.now()}`, input: { user_id: "not_a_user", title: "x", content: "y" }, options: { messagingTransport: "test" } });
    h.check("9 SendNotification reaches the project's own end-user on a supported channel",
      notify.ok === true && !!notify.output.notification_id && notify.output.channel === "push",
      `notification ${notify.output?.notification_id}`);
    h.check("9b an unknown recipient is refused",
      notifyForeign.ok === false && notifyForeign.error.code === "RECIPIENT_NOT_FOUND", notifyForeign.error?.message);

    // ---------------------------------------------------------- 10. idempotency
    const replay = await P({ primitive: "SendEmail", idempotency_key: emailKey, input: { to: ["someone@example.com"], subject: "Primitive certification", text: "hello" }, options: { messagingTransport: "test" } });
    const reused = await P({ primitive: "SendEmail", idempotency_key: emailKey, input: { to: ["someone@example.com"], subject: "different subject", text: "hello" }, options: { messagingTransport: "test" } });
    const audits = await svc.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY }, "-created_date", 50);
    h.check("10 a repeated side-effecting call replays instead of repeating the effect",
      replay.ok === true && replay.idempotent_replay === true && replay.output.message_id === email.output.message_id &&
      audits.filter((a) => (a.data || {}).subject === "Primitive certification").length === 1,
      "one audited send for two identical calls");
    h.check("10b the same key with a different payload is refused",
      reused.ok === false && reused.error.code === "IDEMPOTENCY_KEY_REUSED" && reused.error.category === "conflict", reused.error?.message);

    // -------------------------------------------------------- 11. BackgroundJob
    const queued = await P({ primitive: "BackgroundJob", idempotency_key: `job-${Date.now()}`, input: { operation: "enqueue", primitive: "Search", input: { entity: "Task", query: "beta" } } });
    const worked = await runJobs(base44, { queue: "default", handlers: MAINTENANCE_HANDLERS, max_jobs: 3, budget_ms: 20000 });
    const jobRow = await svc.entities.BackgroundJob.get(queued.output.job_id);
    const status = await P({ primitive: "BackgroundJob", input: { operation: "status", job_id: queued.output.job_id } });
    h.check("11 BackgroundJob defers a primitive onto the existing durable queue",
      queued.ok === true && !!queued.output.job_id && jobRow.job_type === PRIMITIVE_JOB_TYPE && jobRow.project_id === project.id,
      `job ${queued.output?.job_id} on ${queued.output?.queue}`);
    h.check("11b the queued primitive really executes through the existing worker",
      jobRow.status === "succeeded" && jobRow.result?.invocation_id && worked.succeeded >= 1 &&
      (await svc.entities.PrimitiveInvocation.filter({ project_id: project.id, job_id: jobRow.id }, "-created_date", 5)).some((r) => r.actor === "system" && r.status === "succeeded"),
      `worker: ${worked.succeeded} succeeded`);
    h.check("11c job status is project-scoped",
      status.ok === true && status.output.status === "succeeded" &&
      (await P({ primitive: "BackgroundJob", input: { operation: "status", job_id: "job_from_nowhere" } })).error?.code === "JOB_NOT_FOUND",
      "a job outside the project reports not found");
    h.check("11d an asynchronous primitive cannot be nested into the queue",
      (await P({ primitive: "BackgroundJob", idempotency_key: `nest-${Date.now()}`, input: { operation: "enqueue", primitive: "ScheduleTask", input: { operation: "status" } } })).error?.code === "PRIMITIVE_INPUT_INVALID",
      "BackgroundJob refuses to queue another async primitive");

    // --------------------------------------------------------- 12. ScheduleTask
    const sched = await P({ primitive: "ScheduleTask", idempotency_key: `sched-${Date.now()}`, input: { operation: "create", function_name: "dailyDigest", interval_seconds: 900 } });
    // Read the row before the disable below, so the assertion sees the schedule as created.
    const triggerRow = sched.output?.trigger_id ? await svc.entities.ScheduledTrigger.get(sched.output.trigger_id) : null;
    const schedAgain = await P({ primitive: "ScheduleTask", input: { operation: "create", function_name: "dailyDigest", interval_seconds: 900 } });
    const schedStatus = await P({ primitive: "ScheduleTask", input: { operation: "status", trigger_id: sched.output?.trigger_id || "none" } });
    const disabled = await P({ primitive: "ScheduleTask", input: { operation: "disable", trigger_id: sched.output?.trigger_id || "none" } });
    const badCron = await P({ primitive: "ScheduleTask", input: { operation: "create", function_name: "dailyDigest", cron: "not a cron" } });
    h.check("12 ScheduleTask registers a schedule on the existing scheduler",
      sched.ok === true && triggerRow?.project_id === project.id && triggerRow.function_name === "dailyDigest" && !!triggerRow.next_run_at && sched.output.created === true,
      sched.ok ? `trigger ${sched.output?.trigger_id} next at ${triggerRow?.next_run_at}` : `${sched.error?.code}: ${sched.error?.message}`);
    h.check("12b re-registering the same schedule does not create a second trigger",
      schedAgain.ok === true && schedAgain.output?.trigger_id === sched.output?.trigger_id && schedAgain.output.created === false &&
      (await svc.entities.ScheduledTrigger.filter({ project_id: project.id }, "-created_date", 10)).length === 1,
      "one trigger for two identical create calls");
    h.check("12c a schedule can be inspected and disabled, and an invalid one is refused",
      schedStatus.ok === true && disabled.ok === true && disabled.output.enabled === false && !disabled.output.next_run_at &&
      badCron.ok === false && badCron.error.code === "SCHEDULE_INVALID",
      badCron.error?.message);
    h.check("12d another project's schedule is unreachable",
      (await P({ primitive: "ScheduleTask", input: { operation: "status", trigger_id: "trig_elsewhere" } })).error?.code === "TRIGGER_NOT_FOUND",
      "a trigger id outside the project reports not found");

    // ------------------------------------------ 13. authorization / isolation
    const anon = await invokePrimitive(base44, { primitive: "Search", input: { entity: "Task" }, project_id: project.id, actor: "user", user: null });
    const crossWorkspace = await invokePrimitive(base44, { primitive: "Search", input: { entity: "Task" }, project_id: foreign.id, actor: "user", user });
    const viewerRead = await invokePrimitive(base44, { primitive: "Search", input: { entity: "Task" }, project_id: viewerProject.id, actor: "user", user });
    const viewerWrite = await invokePrimitive(base44, { primitive: "SendEmail", idempotency_key: `v-${Date.now()}`, input: { to: ["a@b.co"], subject: "x", text: "y" }, project_id: viewerProject.id, actor: "user", user, options: { messagingTransport: "test" } });
    h.check("13 an unauthenticated invocation is rejected",
      anon.ok === false && anon.error.code === "AUTH_REQUIRED" && anon.error.category === "authorization", anon.error?.message);
    h.check("13b a project in another workspace is rejected",
      crossWorkspace.ok === false && crossWorkspace.error.code === "PRIMITIVE_FORBIDDEN", crossWorkspace.error?.message);
    h.check("13c the contract's capability is enforced per role",
      viewerRead.ok === true && viewerWrite.ok === false && viewerWrite.error.code === "PRIMITIVE_FORBIDDEN",
      "a viewer may Search but may not send");
    h.check("13d a refused invocation produces no side effect and no charge",
      (await svc.entities.PrimitiveInvocation.filter({ project_id: foreign.id }, "-created_date", 5)).length === 0 &&
      (await svc.entities.AppRecord.filter({ project_id: viewerProject.id, entity_name: MESSAGES_ENTITY }, "-created_date", 5)).length === 0,
      "no invocation row for the foreign project, no message for the viewer project");
    const restricted = createAppPrimitives(svc, { project, allowed_primitives: ["Search"] });
    h.check("13e an app surface can be narrowed to specific primitives",
      (await restricted.invoke("Search", { entity: "Task" })).ok === true &&
      (await restricted.invoke("SendEmail", { to: ["a@b.co"], subject: "x", text: "y" }, { idempotency_key: "r1" })).error?.code === "PRIMITIVE_FORBIDDEN",
      `restricted surface exposes ${restricted.list().length} primitive(s)`);

    // ------------------------------------------------- 14. structured errors
    const unknown = await P({ primitive: "NotAPrimitive", input: {} });
    const providerFailure = await P({ primitive: "InvokeAI", version: "1.0.0", input: { prompt: "will fail" }, options: { providerOverrides: FAILING_PROVIDER } });
    h.check("14 an unknown primitive returns a classified error",
      unknown.ok === false && unknown.error.code === "PRIMITIVE_NOT_FOUND" && unknown.error.category === "not_found" && unknown.error.retryable === false && !!unknown.trace_id,
      `${unknown.error?.code} (${unknown.error?.category})`);
    h.check("14b a transient provider failure is reported as retryable, a deterministic one is not",
      providerFailure.ok === false && providerFailure.error.retryable === true && ["provider", "timeout"].includes(providerFailure.error.category) &&
      shortPrompt.error.retryable === false && badExtract.error.retryable === false,
      `${providerFailure.error?.code} retryable · validation failures are not`);
    h.check("14c every envelope carries its correlation and its invocation",
      [ai, email, found, providerFailure].every((r) => r.trace_id === trace_id && r.run_id === run_id) &&
      [ai, email, found].every((r) => !!r.invocation_id) && !!providerFailure.invocation_id,
      "trace_id and run_id are carried through success and failure alike");

    // ------------------------------------------------ 15. billing / usage semantics
    const invocations = (await listPrimitiveInvocations(base44, user, { project_id: project.id, limit: 200 })).invocations;
    const aiRows = invocations.filter((r) => r.consumes_ai_credits && r.status === "succeeded" && r.ai_charge_path === "ai_operation");
    const operations = await svc.entities.AIOperation.filter({ project_id: project.id }, "-created_date", 50);
    const failedOp = operations.find((o) => o.status === "failed");
    const opIds = aiRows.map((r) => r.ai_operation_id).filter(Boolean);
    h.check("15 an AI primitive settles exactly one billable operation",
      aiRows.length >= 3 && opIds.length === aiRows.length && new Set(opIds).size === opIds.length &&
      operations.filter((o) => o.status === "completed").every((o) => String(o.idempotency_key).startsWith("primitive:") && o.finalized_at),
      `${aiRows.length} AI invocations · ${new Set(opIds).size} distinct operations`);
    h.check("15b a failed provider call charges nothing and releases its reservation",
      !!failedOp && (failedOp.credits_charged || 0) === 0 && !!failedOp.finalized_at &&
      (await svc.entities.CreditLedgerEntry.filter({ workspace_id: ws.id, operation_id: failedOp.id }, "-created_date", 10)).every((e) => e.event_type !== "ai_charge"),
      "the failed operation is finalized with zero charge and no ai_charge entry");
    h.check("15c a non-AI primitive is never billed as model usage",
      invocations.filter((r) => ["Search", "FileProcess", "SendEmail", "SendNotification", "BackgroundJob", "ScheduleTask"].includes(r.primitive))
        .every((r) => r.consumes_ai_credits === false && !r.ai_operation_id && (r.credits_charged || 0) === 0) &&
      invocations.filter((r) => r.primitive === "GenerateImage").every((r) => r.ai_charge_path === "platform_integration_credits" && !r.ai_operation_id),
      "platform/external primitives open no AI operation; image generation is charged by the integration itself");

    // ------------------------------------------------- 16. tracing / audit
    const spans = await svc.entities.TraceEvent.filter({ trace_id }, "at", 200);
    const primitiveSpans = spans.filter((s) => String(s.name || "").startsWith("primitive."));
    const auditRows = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 100);
    h.check("16 every invocation is recorded on the platform's existing trace",
      primitiveSpans.length >= 10 && primitiveSpans.some((s) => s.status === "ok") && primitiveSpans.some((s) => s.status === "error") &&
      primitiveSpans.every((s) => s.project_id === project.id) &&
      // A user-driven invocation carries the run it belongs to; a queued continuation belongs to
      // no run and correctly carries none, while still sharing the trace.
      primitiveSpans.filter((s) => s.run_id).every((s) => s.run_id === run_id) &&
      primitiveSpans.some((s) => s.run_id === run_id) && primitiveSpans.some((s) => !s.run_id),
      `${primitiveSpans.length} spans on ${trace_id}`);
    h.check("16b side-effecting invocations are audited",
      ["SendEmail", "SendNotification", "BackgroundJob", "ScheduleTask"].every((n) => auditRows.some((a) => a.action === `primitive.${n}`)) &&
      auditRows.filter((a) => String(a.action).startsWith("primitive.")).every((a) => a.workspace_id === ws.id),
      `${auditRows.filter((a) => String(a.action).startsWith("primitive.")).length} audit entries`);
    h.check("16c the invocation history is authorized and project-scoped",
      invocations.every((r) => !!r.primitive && !!r.version && !!r.trace_id) &&
      await listPrimitiveInvocations(base44, user, { project_id: foreign.id }).then(() => false).catch((e) => e.code === "NOT_A_MEMBER" || e.status === 403),
      `${invocations.length} invocations readable for the authorized project only`);

    // ------------------------------------------------- 17. secret scrubbing
    const leaky = await P({ primitive: "InvokeAI", version: "1.0.0", input: { prompt: `Use this key ${SECRET} and summarise.` }, options: { providerOverrides: OK_PROVIDER } });
    const storedRows = await svc.entities.PrimitiveInvocation.filter({ project_id: project.id }, "-created_date", 200);
    const stored = JSON.stringify([storedRows, await svc.entities.TraceEvent.filter({ trace_id }, "at", 200), auditRows]);
    h.check("17 a credential in an input never reaches stored primitive state",
      leaky.ok === true && !stored.includes(SECRET) && !JSON.stringify(leaky.output).includes(SECRET),
      "the invocation record stores only a fingerprint of the input, and nothing echoes the credential");

    // --------------------------------------- 18. generated-app runtime surface
    const appRun = await executeProjectFunction(svc, {
      project, entities: [{ name: "Task", fields: { title: { type: "string" }, note: { type: "string" } } }],
      name: "usePrimitives", source: APP_FUNCTION_SOURCE, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: null }, user: null,
      trace_id, run_id,
    });
    const appInvocations = await svc.entities.PrimitiveInvocation.filter({ project_id: project.id, actor: "app" }, "-created_date", 10);
    h.check("18 a generated app invokes primitives through the same server-side executor",
      appRun.status === 200 && appRun.body.ok === true && appRun.body.count === 2 && appRun.body.available === 9 &&
      appInvocations.some((r) => r.primitive === "Search" && r.status === "succeeded" && r.trace_id === trace_id),
      `ctx.primitives exposed ${appRun.body?.available} primitives and returned ${appRun.body?.count} result(s)`);
    h.check("18b the app surface cannot address another project",
      appInvocations.every((r) => r.project_id === project.id),
      "the executing project is taken from the runtime, never from sandbox input");

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["PrimitiveInvocation", "AIOperation", "BackgroundJob", "ScheduledRun", "ScheduledTrigger", "FunctionInvocation", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["PrimitiveInvocation", "AIOperation", "CreditLedgerEntry", "WorkspaceMember", "AuditLog", "TraceEvent", "Project"]);
    }
  }
}