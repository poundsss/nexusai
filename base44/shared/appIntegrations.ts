// The generated-app INTEGRATIONS runtime surface: the upstream SDK's `base44.integrations`
// module — the Core platform endpoints and `custom.call` — dispatched onto the EXISTING
// certified server primitives:
//
//   InvokeLLM / GenerateImage / ExtractDataFromUploadedFile → the primitive executor (#27,
//     shared/primitives.ts), which owns authorization, contract validation, idempotency,
//     AI-operation billing and scrubbing;
//   UploadFile / UploadPrivateFile / CreateFileSignedUrl → the file-storage primitives
//     (P-9.2 / P-9.7, shared/appFiles.ts), which own MIME/size enforcement, credit holds,
//     ownership checks and signed URLs;
//   SendEmail → the messaging primitive (P-9.2, shared/appMessaging.ts), which owns
//     validation, daily quota, per-delivered-recipient charging and audit;
//   GenerateVideo / GenerateSpeech / TranscribeAudio → the platform's own Core media
//     integrations, charged through the EXISTING integration-credit hold/settle/release
//     infrastructure (P-9.2) at the published rates; TranscribeAudio carries no charge
//     (Base44 publishes no rate for it, so none is invented);
//   custom.call → the ONE custom-integration engine (#31), reached through the function
//     executor exactly like a backend function's ctx.integrations, so retry, circuit breaker,
//     quota, rate-limit, redaction and observability all apply unchanged.
//
// This module owns ONLY dispatch and the upstream↔primitive parameter mapping. It introduces
// no billing, storage, executor or integration subsystem, and it never re-implements a
// handler: every call lands on the same code path a backend function uses.
//
// Deviations from the upstream wire shapes are deliberate and marked NEXUSAI-DERIVED inline:
// the existing storage model never hands the internal `file_uri` to frontend code, so
// UploadPrivateFile returns the upload's public metadata (whose `id` is the app's handle) and
// CreateFileSignedUrl accepts exactly that handle. The signed-URL read path itself is the
// existing files.access implementation, unchanged.
import { invokePrimitive } from "./primitives.ts";
import { PRIMITIVE_LIMITS } from "./primitiveContract.ts";
import { getModel, listModels } from "./modelCatalog.ts";
import { normalizeImageUrls } from "./attachments.ts";
import { runWebSearch } from "./webSearch.ts";
import { uploadFile, uploadPublicFile, accessFile, FILES_ENTITY } from "./appFiles.ts";
import { sendEmail, sendPush } from "./appMessaging.ts";
import { executeProjectFunction } from "./functionRuntime.ts";
import { holdIntegrationCredits, INTEGRATION_CREDIT_RATES, speechCreditsFor } from "./integrationCharges.ts";

/** The operation vocabulary of the bridge's `integrations` scope. The 7 Core method names
 *  travel verbatim from the generated app; `custom_call` is the bridge form of
 *  `integrations.custom.call(slug, operationId, params)`. */
export const APP_INTEGRATION_OPS = [
  "InvokeLLM", "GenerateImage", "UploadFile", "SendEmail",
  "ExtractDataFromUploadedFile", "UploadPrivateFile", "CreateFileSignedUrl",
  "GenerateVideo", "GenerateSpeech", "TranscribeAudio", "SendPushNotification", "custom_call",
];
/** The Core methods a generated BACKEND function reaches through the documented
 *  `asServiceRole.integrations.Core` namespace (every Core op; custom_call has its own surface). */
export const CORE_SERVICE_ROLE_OPS = APP_INTEGRATION_OPS.filter((o) => o !== "custom_call");

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** Web-search context block handed to the model (exported for deterministic certification).
 *  The results are ALREADY bounded by the adapter's TOTAL_RESULT_CHARS cap; this also clamps
 *  the block so the composed prompt can never exceed the primitive contract's prompt limit. */
export const webContextBlock = (results) => {
  const header = "\n\n### Web search context\n";
  let block = JSON.stringify(results || []);
  const room = PRIMITIVE_LIMITS.prompt_chars - header.length - 1;
  if (block.length > room) block = block.slice(0, room);
  return `${header}${block}`;
};
export const withWebContext = (prompt, results) => `${String(prompt ?? "")}${webContextBlock(results)}`;

/** A primitive envelope failure → the runtime's structured error. NEXUSAI-DERIVED status
 *  mapping (upstream publishes no HTTP statuses for these failures). */
const primitiveFailure = (error) => {
  const status = error?.category === "authorization" ? 403 : error?.code === "INSUFFICIENT_CREDITS" ? 402 : 400;
  // Diagnostics-only: the primitive error's details ride along (no control-flow, status or
  // shape change beyond the optional `details` field itself).
  const e = httpError(status, error?.message || "The operation failed", error?.code || null);
  if (error?.details) e.details = error.details;
  return e;
};

/** The DOCUMENTED (Base44) GenerateSpeech voice set. */
const SPEECH_VOICES = ["river", "honey", "sunny", "storm", "spark"];

/** A refused hold → the runtime's structured 402. A billing refusal, never retried. */
const insufficientCreditsHttp = (e) => {
  if (e?.code === "INSUFFICIENT_CREDITS") {
    throw httpError(402, "Not enough integration credits for this operation", "INSUFFICIENT_CREDITS");
  }
  throw e;
};

/** A failed platform-provider call maps onto the runtime's structured error, after its hold was released by the caller. */
const providerHttpError = (e, what) => {
  const msg = String(e?.message || `The ${what} provider failed`).slice(0, 240);
  const timeout = /timed out|timeout/i.test(msg);
  throw httpError(timeout ? 504 : 502, msg, timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR");
};

/**
 * Handles ONE integrations-scope operation for a generated app.
 *
 * `project` is resolved server-side by the caller (the deployed runtime derives it from the
 * addressed live deployment; the builder preview from the authorized project) and `user` /
 * `session` are the resolved generated-app end-user, so the browser never asserts either.
 * `integrations` are the caller's own normalized integration documents (deployed: the
 * immutable artifact's; preview: the project's working files') — custom.call can only reach
 * them. `transport` is the messaging transport ("platform" deployed, "test" in preview).
 */
export async function handleAppIntegrations(svc, {
  project, integrations = [], user = null, session = null,
  op, args = {}, transport = "platform", trigger = "frontend",
} = {}) {
  const rls = !!project.rls_enabled;
  const scope = { rls, user };

  // --- InvokeLLM -------------------------------------------------------------------
  // Upstream InvokeLLMParams: { prompt, model?, add_context_from_internet?,
  // response_json_schema?, file_urls? } → Promise<string | object>. Every optional parameter
  // now rides an EXISTING certified path — nothing new is invented here:
  //   • model → the router's own preferred-model slot (routeModel.prefer_model_id). Plan
  //     access and affordability are still applied FIRST, and an incompatible, unaffordable
  //     or unknown preference falls back with a recorded reason — the EXISTING behavior for a
  //     manual model selection. No model id, catalog entry or price is invented.
  //   • file_urls → the SHARED reference-image contract (attachments.normalizeImageUrls:
  //     http(s) only, de-duplicated, capped) passed through the Model Gateway's fileUrls
  //     support; routing requires the existing vision capability (requirementsFor.needs_vision).
  //   • add_context_from_internet → the EXISTING bounded webSearch adapter, fail-closed
  //     without a provider key. Only a catalog model carrying the web_search capability may
  //     serve it: a named incompatible model fails deterministically BEFORE any search; with
  //     no model given, the enabled web_search-capable model is preferred (the plan/
  //     affordability fallback stays intact). Whether the platform behaves identically for
  //     `automatic` is UNKNOWN — the deterministic boundary above is this surface's own.
  //   • response_json_schema → unchanged (the certified 1.1.0 InvokeAI mapping).
  if (op === "InvokeLLM") {
    const schema = args.response_json_schema && typeof args.response_json_schema === "object" && !Array.isArray(args.response_json_schema) && Object.keys(args.response_json_schema).length
      ? args.response_json_schema : null;
    const requested = args.model === undefined || args.model === null ? "" : String(args.model).trim();
    const modelId = !requested || requested === "automatic" ? null : requested;
    const fileUrls = normalizeImageUrls(args.file_urls);

    let prefer = modelId;
    let prompt = String(args.prompt ?? "");
    if (args.add_context_from_internet === true) {
      let webModel = null;
      if (modelId) {
        try { webModel = getModel(modelId); } catch { webModel = null; }
        if (!webModel || !(webModel.capabilities || []).includes("web_search")) {
          throw httpError(400, `The model "${modelId}" does not support web search context`, "INTEGRATION_INCOMPATIBLE_MODEL");
        }
      } else {
        webModel = listModels().find((m) => m.active && (m.capabilities || []).includes("web_search")) || null;
        if (!webModel) {
          throw httpError(400, "No enabled model supports web search context", "INTEGRATION_INCOMPATIBLE_MODEL");
        }
      }
      prefer = prefer || webModel.model_id;
      // The bounded, fail-closed adapter — never throws; a missing provider key refuses here.
      const search = await runWebSearch({ query: prompt });
      if (!search.ok) {
        throw httpError(503, search.message || "web search is unavailable", search.code || "WEB_SEARCH_UNAVAILABLE");
      }
      prompt = withWebContext(prompt, search.results);
    }

    const r = await invokePrimitive(svc, {
      primitive: "InvokeAI", project, actor: "app", end_user: user,
      input: { prompt, ...(schema ? { response_schema: schema } : {}) },
      options: {
        ...(prefer ? { routeOverrides: { prefer_model_id: prefer } } : {}),
        ...(fileUrls.length ? { file_urls: fileUrls } : {}),
      },
    });
    if (!r.ok) throw primitiveFailure(r.error);
    // Upstream contract: a string without a schema, an object with one.
    return schema ? r.output.data : r.output.text;
  }

  // --- GenerateImage ---------------------------------------------------------------
  // Upstream GenerateImageParams: { prompt, existing_image_urls? } → { url }. The existing
  // GenerateImage primitive validates the prompt, holds 1 integration credit fail-closed and
  // charges only on success. `existing_image_urls` maps onto the primitive's own reference
  // field verbatim (contract limits apply fail-closed).
  if (op === "GenerateImage") {
    const refs = args.existing_image_urls === undefined ? null : args.existing_image_urls;
    const r = await invokePrimitive(svc, {
      primitive: "GenerateImage", project, actor: "app", end_user: user,
      input: { prompt: args.prompt, ...(Array.isArray(refs) ? { reference_urls: refs } : {}) },
    });
    if (!r.ok) throw primitiveFailure(r.error);
    return { url: r.output.url };
  }

  // --- GenerateVideo -------------------------------------------------------------------
  // DOCUMENTED (Base44): { prompt, duration?: 4|6|8 (default 6), aspect_ratio?: "16:9"|"9:16"
  // (default "16:9"), generate_audio?: bool (default true) } → { url }. Documented rate ~5
  // integration credits per second of video: the hold is the worst case for the RESOLVED
  // duration, placed fail-closed BEFORE the provider call, and the settle charges exactly
  // that duration — the response carries no duration metadata, so the duration the
  // generation ran at IS the delivered one. A failure releases the hold and charges nothing;
  // hold, charge and release derive from ONE logical-operation key, so settlement is
  // exactly-once. Documented defaults are resolved here (the charge needs the duration), so
  // the provider receives the resolved values verbatim.
  if (op === "GenerateVideo") {
    if (typeof args.prompt !== "string" || !args.prompt.trim()) throw httpError(400, "prompt is required", "INTEGRATION_PARAM_REQUIRED");
    if (args.duration !== undefined && args.duration !== null && ![4, 6, 8].includes(args.duration)) {
      throw httpError(400, "duration must be 4, 6 or 8", "INTEGRATION_PARAM_INVALID");
    }
    if (args.aspect_ratio !== undefined && args.aspect_ratio !== null && !["16:9", "9:16"].includes(args.aspect_ratio)) {
      throw httpError(400, 'aspect_ratio must be "16:9" or "9:16"', "INTEGRATION_PARAM_INVALID");
    }
    if (args.generate_audio !== undefined && args.generate_audio !== null && typeof args.generate_audio !== "boolean") {
      throw httpError(400, "generate_audio must be a boolean", "INTEGRATION_PARAM_INVALID");
    }
    const duration = args.duration ?? 6;
    const videoCredits = INTEGRATION_CREDIT_RATES.video_per_second * duration;
    const opKey = `video:${crypto.randomUUID()}`;
    const hold = await holdIntegrationCredits(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: user?.id || null,
      credits: videoCredits, key: opKey,
      reason: `GenerateVideo · ${INTEGRATION_CREDIT_RATES.video_per_second} credits/sec × ${duration}s`,
    }).catch(insufficientCreditsHttp);
    let res;
    try {
      res = await svc.integrations.Core.GenerateVideo({
        prompt: args.prompt, duration,
        aspect_ratio: args.aspect_ratio ?? "16:9",
        generate_audio: args.generate_audio ?? true,
      });
    } catch (e) {
      await hold?.fail().catch(() => {});
      throw providerHttpError(e, "video");
    }
    const url = res?.url || res?.data?.url;
    if (!url) {
      await hold?.fail().catch(() => {});
      throw httpError(502, "The video provider returned no video", "PROVIDER_ERROR");
    }
    await hold?.settle(videoCredits, "GenerateVideo · integration charge", { operation: "generate_video", seconds: duration, credits: videoCredits });
    return { url: String(url) };
  }

  // --- GenerateSpeech ------------------------------------------------------------------
  // DOCUMENTED (Base44): { text (≤5000 chars), voice?: river|honey|sunny|storm|spark
  // (default river), language_code?: ISO-639-1 (auto-detected when absent) } → { url }.
  // Documented charge ~1 credit per 50 characters, capped at 100 per call — computed from
  // the text BEFORE the call, so hold == settle, with the same fail-closed hold,
  // failure-releases and exactly-once-settlement semantics as GenerateVideo. Absent voice
  // and language_code are forwarded absent: the provider's documented defaults apply.
  if (op === "GenerateSpeech") {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) throw httpError(400, "text is required", "INTEGRATION_PARAM_REQUIRED");
    if (text.length > 5000) throw httpError(400, "text must be at most 5000 characters", "INTEGRATION_PARAM_INVALID");
    if (args.voice !== undefined && args.voice !== null && !SPEECH_VOICES.includes(args.voice)) {
      throw httpError(400, `voice must be one of ${SPEECH_VOICES.join(", ")}`, "INTEGRATION_PARAM_INVALID");
    }
    if (args.language_code !== undefined && args.language_code !== null && !/^[a-z]{2}$/i.test(String(args.language_code))) {
      throw httpError(400, "language_code must be an ISO-639-1 code", "INTEGRATION_PARAM_INVALID");
    }
    const speechCredits = speechCreditsFor(text);
    const opKey = `speech:${crypto.randomUUID()}`;
    const hold = await holdIntegrationCredits(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: user?.id || null,
      credits: speechCredits, key: opKey,
      reason: `GenerateSpeech · ${speechCredits} credit(s) for ${text.length} character(s)`,
    }).catch(insufficientCreditsHttp);
    let res;
    try {
      res = await svc.integrations.Core.GenerateSpeech({
        text,
        ...(args.voice ? { voice: args.voice } : {}),
        ...(args.language_code ? { language_code: String(args.language_code).toLowerCase() } : {}),
      });
    } catch (e) {
      await hold?.fail().catch(() => {});
      throw providerHttpError(e, "speech");
    }
    const url = res?.url || res?.data?.url;
    if (!url) {
      await hold?.fail().catch(() => {});
      throw httpError(502, "The speech provider returned no audio", "PROVIDER_ERROR");
    }
    await hold?.settle(speechCredits, "GenerateSpeech · integration charge", { operation: "generate_speech", characters: text.length, credits: speechCredits });
    return { url: String(url) };
  }

  // --- TranscribeAudio -----------------------------------------------------------------
  // DOCUMENTED (Base44): { audio_url } → the transcript as a plain string. NO CHARGE:
  // Base44 publishes no rate for transcription, so none is invented — it stays free until
  // the documented billing contract explicitly establishes one.
  if (op === "TranscribeAudio") {
    const audioUrl = String(args.audio_url ?? "").trim();
    if (!audioUrl) throw httpError(400, "audio_url is required", "INTEGRATION_PARAM_REQUIRED");
    const res = await svc.integrations.Core.TranscribeAudio({ audio_url: audioUrl }).catch((e) => providerHttpError(e, "transcription"));
    if (typeof res !== "string") throw httpError(502, "The transcription provider returned no transcript", "PROVIDER_ERROR");
    return res;
  }

  // --- UploadFile (public) ------------------------------------------------------------
  // Upstream UploadFileParams: { file: File } → { file_url }. Routed to the EXISTING public
  // upload primitive (P-9.7): same bytes pipeline, MIME/size checks, exactly-once idempotency
  // key support and the 1-integration-credit hold/settle — unchanged.
  if (op === "UploadFile") {
    const uploaded = await uploadPublicFile(svc, project.id, {
      filename: args.filename, content_base64: args.content_base64, content_type: args.content_type,
      idempotency_key: args.idempotency_key ?? null,
    }, scope);
    return { file_url: uploaded.url };
  }

  // --- SendPushNotification ------------------------------------------------------------
  // DOCUMENTED (Base44): server-side only, via asServiceRole, to ONE app user. Refused from the
  // frontend bridge so a signed-in end user can never push to other users. Routed to the EXISTING
  // push primitive (recipient scoping, quota, 1-credit-per-delivered hold/settle, in-app record).
  // UNKNOWN: native APNs/FCM delivery — without a native transport the send records the in-app
  // notification and reports delivered:false (charged nothing), never a fabricated delivery.
  if (op === "SendPushNotification") {
    if (trigger !== "function") throw httpError(403, "SendPushNotification can only be called from a backend function via asServiceRole", "PUSH_SERVER_ONLY");
    return await sendPush(svc, project.id, {
      user_id: args.user_id, title: args.title, content: args.content,
      action_label: args.action_label, action_url: args.action_url,
    }, { transport });
  }

  // --- UploadPrivateFile ---------------------------------------------------------------
  // Upstream returns { file_uri }. NEXUSAI-DERIVED deviation, deliberate: the existing storage
  // model never hands the internal storage handle to frontend code — the upload's public
  // metadata IS the app's handle (its `id`), and CreateFileSignedUrl below accepts exactly
  // that handle. The underlying upload implementation is unchanged.
  if (op === "UploadPrivateFile") {
    return await uploadFile(svc, project.id, {
      filename: args.filename, content_base64: args.content_base64, content_type: args.content_type,
    }, scope);
  }

  // --- CreateFileSignedUrl ---------------------------------------------------------------
  // Upstream CreateFileSignedUrlParams: { file_uri, expires_in? } → { signed_url } (SDK 0.8.52).
  // The file handle is the id UploadPrivateFile returned; the URL is minted by the EXISTING
  // ownership-checked signed-URL primitive, unchanged. The optional documented `expires_in`
  // (default 300) is forwarded VERBATIM — the platform primitive owns all TTL validation
  // (LIVE-VERIFIED 2026-10-03: it serves the custom TTL and refuses out-of-range values
  // server-side); no bounds or coercion are invented here. Omitted → the standard 300s.
  if (op === "CreateFileSignedUrl") {
    const handle = String(args.file_uri ?? "").trim();
    if (!handle) throw httpError(400, "file_uri is required", "INTEGRATION_PARAM_REQUIRED");
    const r = await accessFile(svc, project.id, handle, { ...scope, expires_in: args.expires_in ?? null });
    return { signed_url: r.url, expires_in: r.expires_in || 300 };
  }

  // --- SendEmail -----------------------------------------------------------------------
  // Upstream SendEmailParams: { to, subject, body? | html?, text?, from_name?, attachments? }.
  // DOCUMENTED (Base44): `html` is the same body as `body` under an explicit name (set one or
  // the other, never both); `text` alongside body/html rides as the multipart/alternative
  // plain-text part; on its own, `text` sends a plain-text email; `attachments` — at most 5,
  // ≤5 MB each and ≤10 MB total, documents and images only, as [{filename, file_url}] for a
  // file THIS app uploaded or [{filename, content}] base64. Everything routes to the EXISTING
  // messaging primitive: the same validation, daily quota, hold-before-send and
  // per-DELIVERED-recipient charging, unchanged. The `body` mapping changes from the surface's
  // previous `text: args.body` to `html`: the upstream contract names body/html one field, so
  // the old plain-text reading was a mapping error, not a certified behavior.
  if (op === "SendEmail") {
    const html = args.html !== undefined && args.html !== null ? String(args.html)
      : args.body !== undefined && args.body !== null ? String(args.body) : undefined;
    const text = args.text !== undefined && args.text !== null ? String(args.text) : undefined;
    return await sendEmail(svc, project.id, {
      to: args.to, subject: args.subject, text, html, from_name: args.from_name, attachments: args.attachments,
    }, { transport });
  }

  // --- ExtractDataFromUploadedFile -----------------------------------------------------
  // Upstream params: { file_url, json_schema } → object. `file_url` is the public URL this
  // surface's own Core.UploadFile returns; it is resolved back to this project's OWN upload
  // record — anything else (another project's file, a foreign URL) fails closed, so the
  // platform extractor can never be aimed outside the project. Execution and the
  // 1-integration-credit charge belong to the EXISTING ExtractStructuredData primitive.
  if (op === "ExtractDataFromUploadedFile") {
    const fileUrl = String(args.file_url ?? "").trim();
    const schema = args.json_schema && typeof args.json_schema === "object" && !Array.isArray(args.json_schema) ? args.json_schema : null;
    if (!fileUrl) throw httpError(400, "file_url is required", "INTEGRATION_PARAM_REQUIRED");
    if (!schema || !Object.keys(schema).length) throw httpError(400, "json_schema is required", "INTEGRATION_PARAM_REQUIRED");
    const rows = await svc.entities.AppRecord.filter({ project_id: project.id, entity_name: FILES_ENTITY }, "-created_date", 500).catch(() => []);
    const row = rows.find((r) => (r.data || {}).file_url === fileUrl);
    if (!row) throw httpError(404, "File not found in this project", "FILE_NOT_FOUND");
    const r = await invokePrimitive(svc, {
      primitive: "ExtractStructuredData", project, actor: "app", end_user: user,
      input: { file_id: row.id, schema },
    });
    // DOCUMENTED + LIVE-VERIFIED (Base44 platform, 2026-10-03) response envelope:
    //   • success → { status: "success", details, output: list | dict }. An array extraction is
    //     a BARE LIST (root-array schema, live-verified); the primitive stores a list as
    //     { items }, unwrapped here back to the documented list form. The platform itself
    //     populates `details` with a human summary on success; the primitive's contract does
    //     not expose it, so this surface returns null — the one known, evidence-backed
    //     deviation, reported rather than invented around.
    //   • an extraction that ran but produced nothing usable → { status: "error", details,
    //     output: null } as a NORMAL response (live-verified: a supported file whose columns
    //     cannot satisfy the schema → status "error" with the extractor's mapping details).
    //   • structural refusals stay fail-closed HTTP errors — live-verified: unsupported file
    //     type → 400, missing/invalid schema → 422/500 on the platform; foreign files fail
    //     closed on the existing ownership check; credit/authorization failures stay fail-closed.
    if (!r.ok) {
      if (r.error?.code === "EXTRACTION_INVALID") {
        return { status: "error", details: r.error?.message || "Extraction failed", output: null };
      }
      throw primitiveFailure(r.error);
    }
    const data = r.output.data;
    const output = schema.type === "array" && data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.items)
      ? data.items : data;
    return { status: "success", details: null, output };
  }

  // --- custom.call -----------------------------------------------------------------------
  // Upstream: custom.call(slug, operationId, { payload?, pathParams?, queryParams? }) →
  // { success, status_code, data }. The EXISTING engine executes it — the same path a backend
  // function's ctx.integrations rides — through a generated function that calls the
  // integration operation, so breaker/quota/rate-limit/observer/tracing/redaction all apply
  // exactly as a backend function experiences them. Credentials resolve inside the executor
  // and never enter any response.
  if (op === "custom_call") {
    const slug = String(args.slug ?? "").trim();
    const opId = String(args.operation_id ?? args.operationId ?? "").trim();
    if (!slug || !opId) throw httpError(400, "Integration slug and operation ID are required", "INTEGRATION_PARAM_REQUIRED");
    const integ = (integrations || []).find((i) => i && i.name === slug);
    if (!integ) throw httpError(404, `Integration "${slug}" not found`, "INTEGRATION_NOT_FOUND");
    let target = integ.operations.find((o) => o && o.name === opId);
    if (!target) {
      // Upstream documents operationId in "method:path" form (e.g. "get:/contacts"); the
      // existing registry names operations in lowerCamelCase. Both forms resolve onto the
      // SAME registry entry — there is no second operation namespace.
      const m = /^(get|post|put|patch|delete):(.+)$/i.exec(opId);
      if (m) target = integ.operations.find((o) => o && o.method === m[1].toUpperCase() && o.path === (m[2].startsWith("/") ? m[2] : `/${m[2]}`));
    }
    if (!target) throw httpError(404, `Operation "${opId}" not found on integration "${slug}"`, "OPERATION_NOT_FOUND");
    const p = args.params && typeof args.params === "object" && !Array.isArray(args.params) ? args.params : {};
    const pathParams = p.pathParams ?? p.path_params ?? {};
    const queryParams = p.queryParams ?? p.query_params ?? {};
    const flat = {
      ...(pathParams && typeof pathParams === "object" ? pathParams : {}),
      ...(queryParams && typeof queryParams === "object" ? queryParams : {}),
      ...(p.payload !== undefined ? { body: p.payload } : {}),
    };
    // integ.name and target.name are validated identifiers (INTEGRATION_NAME_RE /
    // OPERATION_NAME_RE at normalization), and the params travel through the request body —
    // nothing caller-supplied is interpolated into the source.
    const source = `export const config = { method: 'POST' };\n` +
      `export default async function handler(ctx) {\n` +
      `  const flat = (ctx.request && ctx.request.body && ctx.request.body.flat) || {};\n` +
      `  try {\n` +
      `    const r = await ctx.integrations.${integ.name}.${target.name}(flat);\n` +
      `    return { status: 200, body: { success: true, status_code: r.status, data: r.body === undefined ? null : r.body } };\n` +
      `  } catch (e) {\n` +
      `    const d = e.details || {};\n` +
      `    const s = Number(d.status) || 0;\n` +
      `    if (s > 0) return { status: 200, body: { success: false, status_code: s, data: d.upstream_body === undefined ? null : d.upstream_body } };\n` +
      `    return { status: 200, body: { integration_error: true, code: e.code || 'UPSTREAM_FAILURE', message: String(e.message || e).slice(0, 300) } };\n` +
      `  }\n` +
      `}\n`;
    const result = await executeProjectFunction(svc, {
      project, entities: [], integrations: [integ], name: "customIntegrationCall", source,
      trigger, requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { flat } },
      user: user || null, session: session || null,
      quotas: { timeoutMs: 30000 },
    });
    const body = result.body || {};
    // An upstream HTTP answer — ANY status — maps onto the documented response object
    // (success = 2xx). Only infrastructure-level failures (network/timeout) reject, mirroring
    // the upstream contract's throw cases.
    if (body.integration_error) {
      throw httpError(body.code === "TIMEOUT" ? 504 : 502, body.message || "The external API call failed", body.code || "UPSTREAM_FAILURE");
    }
    return { success: body.success === true, status_code: body.status_code, data: body.data === undefined ? null : body.data };
  }

  throw httpError(400, `Unsupported integration operation ${op}`, "INTEGRATION_OP_UNSUPPORTED");
}