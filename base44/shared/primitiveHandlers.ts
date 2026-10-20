// The primitive IMPLEMENTATIONS (#27).
//
// Each handler is a thin, bounded adapter onto a capability the platform ALREADY owns:
//   InvokeAI / ExtractStructuredData → the existing Model Gateway + the existing credit
//     reserve/settle path (beginOperation → provider call → finalizeOperation)
//   GenerateImage                    → the existing platform image integration
//   FileProcess                      → the existing project-scoped file primitives
//   Search                           → the existing project-scoped application data
//   SendEmail / SendNotification     → the existing messaging transports and their quotas
//   BackgroundJob                    → the existing durable job queue
//   ScheduleTask                     → the existing scheduled-trigger infrastructure
//
// No handler holds a credential, opens a network policy of its own, or introduces a second
// gateway, billing path, queue, scheduler or runtime. Everything a handler returns is a plain,
// caller-safe value: provider handles, tokens, secrets and file storage URIs never leave here.
import { routeModel, createGateway, executionChainIds } from "./modelGateway.ts";
import { beginOperation, finalizeOperation } from "./aiOperations.ts";
import { resolveModelAccess } from "./subscriptions.ts";
import { getFileMeta, accessFile } from "./appFiles.ts";
import { sendEmail, sendPush } from "./appMessaging.ts";
import { enqueue } from "./jobQueue.ts";
import { computeNextRun } from "./scheduler.ts";
import { parseCron, tzOffsetMs } from "./cron.ts";
import { resolvePrimitive, validateAgainstSchema, PRIMITIVE_LIMITS } from "./primitiveContract.ts";
import { scrubText } from "./tracing.ts";
import { holdIntegrationCredits, INTEGRATION_CREDIT_RATES } from "./integrationCharges.ts";

/** THE primitive error. Category drives retryability, so classification is never ad hoc. */
export function primitiveError(code, category, message, { retryable = null, external_reference = null, details = null } = {}) {
  return Object.assign(new Error(String(message || code)), {
    primitive_error: true, code, category,
    retryable: retryable === null ? ["rate_limit", "provider", "timeout"].includes(category) : !!retryable,
    external_reference, details,
  });
}

// P-9.2: a refused hold is a billing refusal, not a provider fault — deterministic, never retried.
const insufficientCredits = (e) => {
  if (e?.code === "INSUFFICIENT_CREDITS") throw primitiveError("INSUFFICIENT_CREDITS", "billing", "Not enough integration credits for this operation", { retryable: false });
  throw e;
};

const clamp = (text, max) => {
  const s = String(text ?? "");
  return { text: s.slice(0, max), truncated: s.length > max };
};

// --- AI (Model Gateway + existing credit semantics) --------------------------------

const QUALITY_STRATEGY = { fast: "fastest", standard: "balanced", advanced: "best_quality" };

/**
 * One bounded model call, billed EXACTLY ONCE through the existing operation path.
 *
 * The reservation is opened before the provider call and settled after it: a provider failure
 * releases the hold and charges nothing, and the invocation's own id is the idempotency key, so a
 * replayed invocation settles the SAME operation instead of charging twice.
 */
async function runModel(ctx, { prompt, system, quality, maxOutputTokens, jsonSchema = null, fileUrls = null, operationSuffix = "" }) {
  const { base44, svc, project, workspace, user, contract, trace_id, run_id, invocation_id, options } = ctx;
  // P-8.4: plan-based model access, resolved server-side before routing — the caller's quality
  // preference is honored only WITHIN what the workspace's plan allows, never past it.
  const modelAccess = await resolveModelAccess(svc, { workspace_id: workspace.id });
  const routed = routeModel({
    mode: "default", prompt,
    // Attached files (the shared reference-image contract) ride the EXISTING routing inputs:
    // they count as files and require the router's vision capability, so a non-vision model is
    // never chosen for an attachment-bearing call. Absent files leave routing byte-identical.
    ...(fileUrls?.length ? { fileCount: fileUrls.length, needs_vision: true } : {}),
    strategy: QUALITY_STRATEGY[quality] || "balanced", modelAccess,
    ...(options.routeOverrides || {}),
  });
  const model = routed.model;

  // Credit pool follows the caller, matching the AIOperation contract: "message" for platform
  // automation (Builder/Agent/workflow — actor "user"|"system"), "integration" for a generated
  // app's end-user-driven call (actor "app", live-app usage). A workflow InvokeAI step is platform
  // automation and so charges the message pool the rest of the AI path uses — without this, a
  // workspace with only message credits would see every workflow InvokeAI step fail at the budget
  // guard before an AIOperation is ever opened.
  const creditType = ctx.actor === "app" ? "integration" : "message";
  const { operation } = await beginOperation(svc, {
    workspace_id: workspace.id, user_id: user?.id || null, project_id: project.id, run_id: run_id || null,
    operation_type: "other", model_id: model.model_id, gateway_provider: model.provider, creditType,
    idempotency_key: `primitive:${invocation_id}${operationSuffix}`,
    // Chain-aware reservation parity with Builder/Agent: the hold covers every model the gateway
    // may actually execute for this call (primary + default compatible fallbacks), not just the
    // routed primary. Reservation sizing only — pricing, ledger keys, settlement and the
    // gateway's own fallback behaviour are unchanged.
    candidate_model_ids: executionChainIds(model),
    estimate: { max_input_tokens: Math.ceil(String(prompt).length / 4) + 500, max_output_tokens: maxOutputTokens },
    routing: { primitive: contract.name, primitive_version: contract.version, decision: routed.decision?.reason || routed.reason },
  });

  // The EXISTING gateway, with the same client shape every other caller hands it.
  const gateway = createGateway(base44, options.providerOverrides ? { providerOverrides: options.providerOverrides } : {});
  try {
    const res = await gateway.generate(model, {
      system: system || "You are a helpful assistant embedded in a generated application.",
      messages: [{ role: "user", content: prompt }],
      jsonSchema, timeoutMs: Math.min(contract.timeout_ms, 55000),
      maxAttempts: contract.retry.max_attempts,
      modelAccess,
      trace: { trace_id, run_id: run_id || null, project_id: project.id, workspace_id: workspace.id },
      ...(fileUrls?.length ? { fileUrls } : {}),
    });
    const settled = await finalizeOperation(svc, {
      operation_id: operation.id, usage: res.usage, usage_source: res.usage?.usage_source || "estimated",
      status: "completed",
    });
    const used = res.model_used || model;
    return {
      output: res.output,
      model_id: used.model_id || used.id, provider: used.upstream_provider || used.provider,
      ai_operation_id: operation.id, credits_charged: settled.credits_charged || 0,
      usage: {
        input_tokens: res.usage?.input_tokens ?? null, output_tokens: res.usage?.output_tokens ?? null,
        total_tokens: res.usage?.total_tokens ?? null, usage_source: res.usage?.usage_source || "estimated",
      },
    };
  } catch (e) {
    // A failed provider call must never produce a charge: the reservation is released here.
    await finalizeOperation(svc, { operation_id: operation.id, status: "failed", error: scrubText(e.message, 300) }).catch(() => {});
    const timeout = /timed out|timeout/i.test(String(e.message || "")) || e.code === "PROVIDER_TIMEOUT";
    throw primitiveError(
      e.code === "INSUFFICIENT_CREDITS" ? "INSUFFICIENT_CREDITS" : timeout ? "PROVIDER_TIMEOUT" : e.code === "PROVIDER_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "PROVIDER_ERROR",
      timeout ? "timeout" : e.retryable === false ? "provider" : "provider",
      scrubText(e.message, 240),
      { retryable: timeout ? true : e.retryable !== false, details: { model_id: model.model_id } },
    );
  }
}

const invokeAI = async (ctx) => {
  const { input, contract, options } = ctx;
  const wantsJson = contract.version !== "1.0.0" && input.response_schema && Object.keys(input.response_schema).length > 0;
  // `options.file_urls` is the integrations surface's validated attachment list (the shared
  // reference-image contract); the primitive contract itself is unchanged.
  const fileUrls = Array.isArray(options?.file_urls) && options.file_urls.length ? options.file_urls : null;
  const res = await runModel(ctx, {
    prompt: input.prompt, system: input.system, quality: input.quality,
    maxOutputTokens: input.max_output_tokens, jsonSchema: wantsJson ? input.response_schema : null,
    ...(fileUrls ? { fileUrls } : {}),
  });
  const raw = res.output;
  const asText = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const bounded = clamp(asText, PRIMITIVE_LIMITS.output_chars);
  return {
    ...res,
    output: {
      text: bounded.text, truncated: bounded.truncated,
      ...(wantsJson && raw && typeof raw === "object" ? { data: raw } : {}),
      model_id: res.model_id, provider: res.provider,
    },
  };
};

const generateImage = async (ctx) => {
  const { svc, project, workspace, input, invocation_id } = ctx;
  // P-9.2: 1 integration credit per image (Base44-verified rate). Fail-closed hold BEFORE the
  // provider call; the charge lands only on success — a provider failure releases the hold and
  // charges nothing. Hold/charge/release all key off the invocation, so a replayed invocation
  // settles the same entries instead of charging twice.
  const hold = await holdIntegrationCredits(svc, {
    workspace_id: workspace.id, project_id: project.id,
    credits: INTEGRATION_CREDIT_RATES.generate_image,
    key: `image:${invocation_id}`, reason: "GenerateImage · 1 credit per image",
  }).catch(insufficientCredits);
  let res;
  try {
    res = await svc.integrations.Core.GenerateImage({
      prompt: input.prompt,
      ...(input.reference_urls?.length ? { existing_image_urls: input.reference_urls } : {}),
    });
  } catch (e) {
    await hold?.fail().catch(() => {});
    const timeout = /timed out|timeout/i.test(String(e.message || ""));
    throw primitiveError(timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR", timeout ? "timeout" : "provider", scrubText(e.message, 240));
  }
  const url = res?.url || res?.data?.url;
  if (!url) {
    await hold?.fail().catch(() => {});
    throw primitiveError("PROVIDER_ERROR", "provider", "The image provider returned no image");
  }
  const settled = await hold?.settle(INTEGRATION_CREDIT_RATES.generate_image, "GenerateImage · integration charge", { operation: "generate_image", credits: INTEGRATION_CREDIT_RATES.generate_image });
  return {
    output: { url: String(url), provider: "platform_image" },
    credits_charged: settled?.charged || 0,
    usage: { images: 1, credits_charged: settled?.charged || 0, rate: `${INTEGRATION_CREDIT_RATES.generate_image} integration credit per image` },
  };
};

const extractStructuredData = async (ctx) => {
  const { svc, project, workspace, input, invocation_id } = ctx;
  const schema = input.schema && typeof input.schema === "object" ? input.schema : null;
  if (!schema || !Object.keys(schema).length) throw primitiveError("PRIMITIVE_INPUT_INVALID", "validation", "input.schema must declare the structure to extract", { retryable: false });
  if (!input.text && !input.file_id) throw primitiveError("PRIMITIVE_INPUT_INVALID", "validation", "either input.text or input.file_id is required", { retryable: false });

  // FILE path: the platform's own extraction integration, reached through a short-lived signed
  // URL minted after the project ownership check. The storage handle never leaves the server.
  if (input.file_id) {
    // A PUBLIC file row carries its permanent URL directly (P-9.7) and has no private storage
    // handle, so the signed-URL path below would refuse it — such a row is handed to the
    // extractor by its own public URL. Private rows mint a short-lived signed URL, unchanged.
    const file = await getFileMeta(svc, project.id, input.file_id, { rls: false, user: null })
      .then((meta) => (meta && meta.url ? { url: meta.url } : accessFile(svc, project.id, input.file_id, { rls: false, user: null })))
      .catch((e) => { throw primitiveError("FILE_NOT_FOUND", "not_found", "File not found in this project", { retryable: false, details: { source_code: e?.code || null, source_message: String(e?.message || "").slice(0, 200) } }); });
    // P-9.2: 1 integration credit per extraction call (Base44-verified rate). Same
    // hold → execute → settle semantics as GenerateImage; any failure releases the hold
    // and charges nothing.
    const hold = await holdIntegrationCredits(svc, {
      workspace_id: workspace.id, project_id: project.id,
      credits: INTEGRATION_CREDIT_RATES.file_extraction,
      key: `extraction:${invocation_id}`, reason: "ExtractStructuredData · 1 credit per call",
    }).catch(insufficientCredits);
    let res;
    try {
      res = await svc.integrations.Core.ExtractDataFromUploadedFile({ file_url: file.url, json_schema: schema });
    } catch (e) {
      await hold?.fail().catch(() => {});
      throw primitiveError("PROVIDER_ERROR", "provider", scrubText(e.message, 240));
    }
    if (res?.status !== "success" || res.output == null) {
      await hold?.fail().catch(() => {});
      throw primitiveError("EXTRACTION_INVALID", "validation", scrubText(res?.details || "Extraction did not produce a result", 240), { retryable: false });
    }
    const data = Array.isArray(res.output) ? { items: res.output } : res.output;
    // A root-ARRAY caller schema describes the platform's BARE-LIST extraction output
    // (Base44-verified live: {type:"array"} → output is a bare list). The { items } wrap above
    // is the object storage form, so such a schema validates through its own items declaration
    // instead of rejecting the wrap; the output shape itself is unchanged.
    const check = validateAgainstSchema(
      schema.type === "array" ? { type: "object", properties: { items: schema }, required: ["items"] } : schema,
      data, "data",
    );
    if (!check.ok) {
      await hold?.fail().catch(() => {});
      throw primitiveError("EXTRACTION_INVALID", "validation", `Extraction did not satisfy the declared schema: ${check.errors.join("; ")}`, { retryable: false });
    }
    const settled = await hold?.settle(INTEGRATION_CREDIT_RATES.file_extraction, "ExtractStructuredData · integration charge", { operation: "file_extraction", credits: INTEGRATION_CREDIT_RATES.file_extraction });
    return {
      output: { data, source: "file" },
      credits_charged: settled?.charged || 0,
      usage: { credits_charged: settled?.charged || 0 },
    };
  }

  // TEXT path: the existing Model Gateway, with the caller's schema handed to the model and the
  // result validated against it — an incomplete extraction FAILS instead of returning a guess.
  const res = await runModel(ctx, {
    prompt: `${input.instructions ? `${input.instructions}\n\n` : ""}Extract the requested structure from the following content. Return ONLY the structured result.\n\n---\n${input.text}`,
    system: "You extract structured data. Return only data that is present in the input; never invent values.",
    quality: "standard", maxOutputTokens: 2000, jsonSchema: schema,
  });
  let data = res.output;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
  if (!data || typeof data !== "object") throw primitiveError("EXTRACTION_INVALID", "validation", "The model did not return a structured object", { retryable: false });
  const check = validateAgainstSchema(schema, data, "data");
  if (!check.ok) throw primitiveError("EXTRACTION_INVALID", "validation", `Extraction did not satisfy the declared schema: ${check.errors.join("; ")}`, { retryable: false });
  return { ...res, output: { data, source: "text" } };
};

// --- files (project-scoped, no filesystem access) ----------------------------------

const TEXT_TYPES = new Set(["text/plain", "text/csv", "application/json"]);

const fileProcess = async (ctx) => {
  const { svc, project, input, end_user } = ctx;
  // Ownership is enforced by the EXISTING file primitive: the file must belong to this project
  // (and, on an RLS app, to this end-user). There is no path input, so nothing outside the
  // project's own storage is addressable.
  const scope = { rls: !!project.rls_enabled, user: end_user || null };
  const notFound = () => primitiveError("FILE_NOT_FOUND", "not_found", "File not found in this project", { retryable: false });
  const meta = await getFileMeta(svc, project.id, input.file_id, scope).catch((e) => {
    if (e.code === "AUTH_REQUIRED") throw primitiveError("PRIMITIVE_FORBIDDEN", "authorization", "This file requires an authenticated end-user", { retryable: false });
    throw notFound();
  });
  if (input.operation === "metadata") return { output: { file: meta } };

  const opened = await accessFile(svc, project.id, input.file_id, scope).catch(() => { throw notFound(); });
  if (input.operation === "signed_url") {
    return { output: { file: meta, url: opened.url }, external_reference: null, usage: { expires_in: opened.expires_in } };
  }
  if (!TEXT_TYPES.has(meta.content_type)) {
    throw primitiveError("FILE_TYPE_UNSUPPORTED", "validation", `extract_text supports ${[...TEXT_TYPES].join(", ")}; this file is ${meta.content_type}. Use ExtractStructuredData with file_id for other types.`, { retryable: false });
  }
  const res = await fetch(opened.url).catch((e) => { throw primitiveError("PROVIDER_ERROR", "provider", scrubText(e.message, 200)); });
  if (!res.ok) throw primitiveError("PROVIDER_ERROR", "provider", `Reading the file failed with status ${res.status}`);
  const bounded = clamp(await res.text(), Math.min(input.max_chars, PRIMITIVE_LIMITS.text_chars));
  return { output: { file: meta, text: bounded.text, truncated: bounded.truncated } };
};

// --- search (project data only, deterministic pagination) ---------------------------

const SEARCH_BATCH = 200;

const search = async (ctx) => {
  const { svc, project, input } = ctx;
  const declared = await svc.entities.AppEntity.filter({ project_id: project.id, name: input.entity }, "name", 1);
  if (!declared.length) {
    throw primitiveError("SEARCH_SOURCE_UNKNOWN", "not_found", `This project declares no entity named "${input.entity}"`, { retryable: false });
  }
  const fields = (input.fields || []).map(String).slice(0, PRIMITIVE_LIMITS.search_fields);
  const needle = String(input.query || "").trim().toLowerCase();
  const want = input.limit, offset = input.offset;

  // Scope is a SERVER-side query on project_id + entity_name, so no other project's records can
  // enter the result set. Order is stable (newest first, id as tiebreaker), which is what makes
  // offset pagination deterministic across calls.
  const matched = [];
  let scanned = 0, batchSkip = 0;
  while (matched.length < offset + want && scanned < 5000) {
    const rows = await svc.entities.AppRecord.filter({ project_id: project.id, entity_name: input.entity }, "-created_date", SEARCH_BATCH, batchSkip);
    if (!rows.length) break;
    scanned += rows.length;
    batchSkip += rows.length;
    for (const r of rows) {
      const item = { id: r.id, created_date: r.created_date, ...(r.data || {}) };
      if (!needle) { matched.push(item); continue; }
      const haystack = (fields.length ? fields.map((f) => item[f]) : Object.values(r.data || {}))
        .map((v) => (v == null ? "" : String(v))).join(" ").toLowerCase();
      if (haystack.includes(needle)) matched.push(item);
    }
    if (rows.length < SEARCH_BATCH) break;
  }
  const ordered = matched.sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)) || String(a.id).localeCompare(String(b.id)));
  const page = ordered.slice(offset, offset + want);
  return {
    output: {
      items: page, count: page.length,
      next_offset: ordered.length > offset + want ? offset + want : null,
      source: { type: "app_data", project_id: project.id, entity: input.entity, scanned, matched: ordered.length, query: needle || null },
    },
  };
};

// --- messaging (existing transports, existing quotas) -------------------------------

const sendEmailPrimitive = async (ctx) => {
  const { svc, project, input, options } = ctx;
  try {
    const res = await sendEmail(svc, project.id, {
      to: input.to, subject: input.subject, text: input.text, html: input.html, from_name: input.from_name,
    }, { transport: options.messagingTransport || "platform" });
    return {
      output: { message_id: res.id, recipients: res.recipients, delivered: res.delivered },
      external_reference: res.id,
      usage: { recipients: res.recipients, transport: res.transport },
    };
  } catch (e) {
    const code = e.code || "PROVIDER_ERROR";
    const category = code === "MESSAGING_QUOTA_EXCEEDED" ? "rate_limit" : code === "INSUFFICIENT_CREDITS" ? "billing" : String(code).startsWith("EMAIL_") ? "validation" : "provider";
    throw primitiveError(code === "MESSAGING_QUOTA_EXCEEDED" ? "RATE_LIMITED" : code, category, scrubText(e.message, 240));
  }
};

const sendNotification = async (ctx) => {
  const { svc, project, input, options } = ctx;
  try {
    const res = await sendPush(svc, project.id, {
      user_id: input.user_id, title: input.title, content: input.content,
      action_label: input.action_label, action_url: input.action_url,
    }, { transport: options.messagingTransport || "platform" });
    return {
      output: { notification_id: res.notification_id, channel: input.channel || "push", delivered: !!res.delivered, detail: res.detail || null },
      external_reference: res.notification_id,
      usage: { transport: res.transport },
    };
  } catch (e) {
    const code = e.code || "PROVIDER_ERROR";
    const category = code === "PUSH_RECIPIENT_NOT_FOUND" ? "not_found" : code === "MESSAGING_QUOTA_EXCEEDED" ? "rate_limit" : code === "INSUFFICIENT_CREDITS" ? "billing" : String(code).startsWith("PUSH_") ? "validation" : "provider";
    throw primitiveError(
      code === "PUSH_RECIPIENT_NOT_FOUND" ? "RECIPIENT_NOT_FOUND" : code === "MESSAGING_QUOTA_EXCEEDED" ? "RATE_LIMITED" : code,
      category, scrubText(e.message, 240),
    );
  }
};

// --- background jobs (the EXISTING queue) -------------------------------------------

/** The job type the queue executes a deferred primitive under. Registered in jobHandlers.ts. */
export const PRIMITIVE_JOB_TYPE = "primitive.invoke";

const backgroundJob = async (ctx) => {
  const { base44, svc, project, workspace, input, trace_id, idempotency_key } = ctx;
  if (input.operation === "status") {
    const id = String(input.job_id || "");
    const job = id ? await svc.entities.BackgroundJob.get(id).catch(() => null) : null;
    // A job belonging to another project is reported as not found, so existence never leaks.
    if (!job || job.project_id !== project.id) throw primitiveError("JOB_NOT_FOUND", "not_found", "Job not found for this project", { retryable: false });
    return {
      output: {
        job_id: job.id, status: job.status, queue: job.queue, attempts: job.attempts || 0,
        result: job.result && typeof job.result === "object" ? job.result : {},
        error_code: job.error_code || null,
      },
      external_reference: job.id,
    };
  }

  const target = resolvePrimitive(String(input.primitive || ""), input.primitive_version || null);
  if (!target) throw primitiveError("PRIMITIVE_NOT_FOUND", "validation", `Unknown primitive "${input.primitive}"`, { retryable: false });
  if (target.execution_mode === "async") {
    throw primitiveError("PRIMITIVE_INPUT_INVALID", "validation", `${target.name} is itself asynchronous and cannot be queued from BackgroundJob`, { retryable: false });
  }
  // Input is validated against the TARGET's contract before anything is queued, so an invalid
  // payload fails now rather than dead-lettering later.
  const check = validateAgainstSchema(target.input_schema, input.input || {}, "input.input");
  if (!check.ok) throw primitiveError("PRIMITIVE_INPUT_INVALID", "validation", check.errors.join("; "), { retryable: false });

  const { job, duplicate } = await enqueue(base44, {
    queue: "default", job_type: PRIMITIVE_JOB_TYPE,
    payload: { project_id: project.id, primitive: target.name, version: target.version, input: input.input || {}, trace_id },
    delay_ms: input.delay_ms || 0,
    idempotency_key: idempotency_key ? `primitive:${project.id}:${idempotency_key}` : null,
    workspace_id: workspace.id, project_id: project.id, trace_id,
  });
  return {
    output: { job_id: job.id, status: job.status, queue: job.queue, duplicate: !!duplicate, primitive: target.name, primitive_version: target.version },
    external_reference: job.id,
  };
};

// --- schedules (the EXISTING scheduled-trigger infrastructure) -----------------------

const publicTrigger = (t, created = false) => ({
  trigger_id: t.id, function_name: t.function_name, enabled: t.enabled !== false,
  cron: t.cron || null, interval_seconds: t.interval_seconds ?? null,
  one_time_at: t.one_time_at || null, timezone: t.timezone || "UTC",
  ends_type: t.ends_type || "never", ends_on_date: t.ends_on_date || null, ends_after_count: t.ends_after_count ?? null,
  consecutive_failures: Number(t.consecutive_failures) || 0, run_count: Number(t.run_count) || 0,
  paused_reason: t.paused_reason || null,
  next_run_at: t.next_run_at || null, last_status: t.last_status || null, created,
});

const scheduleTask = async (ctx) => {
  const { svc, project, input } = ctx;
  const own = async (id) => {
    const t = id ? await svc.entities.ScheduledTrigger.get(String(id)).catch(() => null) : null;
    if (!t || t.project_id !== project.id) throw primitiveError("TRIGGER_NOT_FOUND", "not_found", "Schedule not found for this project", { retryable: false });
    return t;
  };
  if (input.operation === "status") return { output: publicTrigger(await own(input.trigger_id)), external_reference: String(input.trigger_id) };
  if (input.operation === "disable") {
    const t = await own(input.trigger_id);
    const off = await svc.entities.ScheduledTrigger.update(t.id, { enabled: false, next_run_at: null });
    return { output: publicTrigger(off), external_reference: t.id };
  }

  // Optional schedule-lifecycle inputs (one-time fire date, end conditions, timezone). Invalid
  // values are refused SCHEDULE_INVALID — exactly like an invalid cron expression.
  const oneTime = input.one_time_at ? new Date(input.one_time_at) : null;
  if (input.one_time_at && Number.isNaN(oneTime.getTime())) {
    throw primitiveError("SCHEDULE_INVALID", "validation", "one_time_at must be a valid date", { retryable: false });
  }
  const endsType = String(input.ends_type || "never");
  if (!["never", "on", "after"].includes(endsType)) {
    throw primitiveError("SCHEDULE_INVALID", "validation", "ends_type must be never, on or after", { retryable: false });
  }
  if (endsType === "on" && !input.ends_on_date) {
    throw primitiveError("SCHEDULE_INVALID", "validation", "ends_on_date is required when ends_type is on", { retryable: false });
  }
  if (endsType === "on" && Number.isNaN(new Date(input.ends_on_date).getTime())) {
    throw primitiveError("SCHEDULE_INVALID", "validation", "ends_on_date must be a valid date", { retryable: false });
  }
  if (endsType === "after" && !(Number(input.ends_after_count) > 0)) {
    throw primitiveError("SCHEDULE_INVALID", "validation", "ends_after_count must be a positive number when ends_type is after", { retryable: false });
  }
  if (input.timezone) {
    try { tzOffsetMs(new Date(), String(input.timezone)); }
    catch { throw primitiveError("SCHEDULE_INVALID", "validation", `unknown timezone "${input.timezone}"`, { retryable: false }); }
  }
  const hasSchedule = !!input.cron || Number(input.interval_seconds) > 0 || !!input.one_time_at;
  if (input.cron) {
    try { parseCron(input.cron); }
    catch (e) { throw primitiveError("SCHEDULE_INVALID", "validation", scrubText(e.message, 200), { retryable: false }); }
  }
  if (input.operation === "update") {
    const t = await own(input.trigger_id);
    const patch = {
      ...(input.function_name ? { function_name: input.function_name } : {}),
      ...(input.cron ? { cron: input.cron, interval_seconds: null } : {}),
      ...(Number(input.interval_seconds) > 0 ? { interval_seconds: Number(input.interval_seconds), cron: null } : {}),
      ...(input.one_time_at !== undefined ? { one_time_at: input.one_time_at ? oneTime.toISOString() : null, cron: null, interval_seconds: null } : {}),
      ...(input.timezone !== undefined ? { timezone: String(input.timezone) || "UTC" } : {}),
      ...(input.ends_type !== undefined ? { ends_type: String(input.ends_type) } : {}),
      ...(input.ends_on_date !== undefined ? { ends_on_date: input.ends_on_date ? new Date(input.ends_on_date).toISOString() : null } : {}),
      ...(input.ends_after_count !== undefined ? { ends_after_count: Number(input.ends_after_count) || null } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.enabled !== undefined ? { enabled: !!input.enabled } : {}),
    };
    const merged = { ...t, ...patch };
    const next = computeNextRun(merged, new Date());
    const saved = await svc.entities.ScheduledTrigger.update(t.id, { ...patch, next_run_at: next ? next.toISOString() : null });
    return { output: publicTrigger(saved), external_reference: t.id };
  }

  // create
  if (!input.function_name) throw primitiveError("PRIMITIVE_INPUT_INVALID", "validation", "function_name is required to create a schedule", { retryable: false });
  if (!hasSchedule) throw primitiveError("SCHEDULE_INVALID", "validation", "Provide either cron or interval_seconds (>= 300s)", { retryable: false });
  // Idempotent by construction: the same function on the same schedule resolves to the existing
  // trigger instead of creating a second one that would fire twice.
  const existing = await svc.entities.ScheduledTrigger.filter({ project_id: project.id, function_name: input.function_name }, "-created_date", 20);
  const same = existing.find((t) => {
    if (t.enabled === false) return false;
    if (input.one_time_at) return t.one_time_at === oneTime.toISOString();
    if (t.one_time_at) return false;
    return input.cron ? t.cron === input.cron : Number(t.interval_seconds) === Number(input.interval_seconds);
  });
  if (same) return { output: publicTrigger(same, false), external_reference: same.id };

  const draft = {
    project_id: project.id, function_name: input.function_name, enabled: true,
    // The scheduler identifies a trigger by a per-project name. It is DERIVED from the function
    // plus the cadence, so the same schedule always resolves to the same trigger name.
    name: `${input.function_name}@${input.one_time_at ? "once" : input.cron ? input.cron : `${Number(input.interval_seconds)}s`}`.slice(0, 120),
    ...(input.one_time_at ? { one_time_at: oneTime.toISOString() } : input.cron ? { cron: input.cron } : { interval_seconds: Number(input.interval_seconds) }),
    ...(input.timezone ? { timezone: String(input.timezone) } : {}),
    ...(endsType !== "never" ? { ends_type: endsType } : {}),
    ...(endsType === "on" ? { ends_on_date: new Date(input.ends_on_date).toISOString() } : {}),
    ...(endsType === "after" ? { ends_after_count: Number(input.ends_after_count) } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };
  const next = computeNextRun(draft, new Date());
  const created = await svc.entities.ScheduledTrigger.create({ ...draft, next_run_at: next ? next.toISOString() : null });
  return { output: publicTrigger(created, true), external_reference: created.id };
};

/** name@version → handler. A primitive with no handler here is not executable. */
export const PRIMITIVE_HANDLERS = {
  "InvokeAI@1.0.0": invokeAI,
  "InvokeAI@1.1.0": invokeAI,
  "GenerateImage@1.0.0": generateImage,
  "ExtractStructuredData@1.0.0": extractStructuredData,
  "FileProcess@1.0.0": fileProcess,
  "Search@1.0.0": search,
  "SendEmail@1.0.0": sendEmailPrimitive,
  "SendNotification@1.0.0": sendNotification,
  "BackgroundJob@1.0.0": backgroundJob,
  "ScheduleTask@1.0.0": scheduleTask,
  "ScheduleTask@1.1.0": scheduleTask,
};