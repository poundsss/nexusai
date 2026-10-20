// Base44 AI Gateway provider adapter — the platform's OpenAI-compatible chat-completions
// endpoint, reached through the EXISTING service-role connection (`aiGateway.connection()`).
//
// It is a peer adapter under the SAME contract as Base44CoreProvider and NexusProvider
// (generate / supportsTools / getModelInfo / stream), so the gateway's existing retry, timeout,
// health and fallback loop drives it unchanged. It exists for ONE reason: InvokeLLM is a single
// call with no tools BY CONTRACT, while the AI Gateway — the SAME managed models and the SAME
// metered quota (documented: billed "exactly like integrations.Core.InvokeLLM") — carries tool
// definitions and returns tool calls on the wire. A tools request must therefore execute HERE,
// never through an adapter that would silently drop `tools`.
//
// The model travels as the catalog's provider_model_name UNCHANGED (gemini_3_flash, gpt_5_mini,
// claude-sonnet-5) — all documented InvokeLLM / AI-Gateway model ids. No new model, no new
// billing rule, no new ledger.
import { normalizeUsage, estimateUsage } from "./economics.ts";
import { scrubText } from "./tracing.ts";

export const GATEWAY_PROVIDER_ID = "base44-gateway";

const gwError = (code, message, retryable, extra = {}) => Object.assign(new Error(message), { code, retryable, provider: GATEWAY_PROVIDER_ID, ...extra });

/** Maps a gateway HTTP failure onto the provider-error vocabulary the gateway's loop consumes. */
function normalizeGatewayHttpError(status, bodyText = "") {
  let detail = "";
  try { const parsed = JSON.parse(bodyText || "{}"); detail = parsed.error || parsed.message || ""; } catch { detail = bodyText || ""; }
  detail = detail ? `: ${scrubText(String(detail), 160)}` : "";
  if (status === 401 || status === 403) return gwError("PROVIDER_REJECTED", `AI Gateway rejected the request (${status}): unauthorized${detail}`, false, { http_status: status });
  if (status === 400 || status === 413 || status === 422) return gwError("PROVIDER_REJECTED", `AI Gateway rejected the request (${status}): invalid request${detail}`, false, { http_status: status });
  if (status === 408 || status === 504) return gwError("PROVIDER_TIMEOUT", `AI Gateway timed out upstream (${status})${detail}`, true, { http_status: status });
  if (status === 429) return gwError("PROVIDER_UNAVAILABLE", `AI Gateway rate limited the request (429)${detail}`, true, { http_status: status, rate_limited: true });
  if (status >= 500) return gwError("PROVIDER_UNAVAILABLE", `AI Gateway unavailable (${status})${detail}`, true, { http_status: status });
  return gwError("PROVIDER_ERROR", `AI Gateway returned an unexpected status ${status}${detail}`, false, { http_status: status });
}

/** An OpenAI chat-completions tool_call → the normalized { id, name, arguments } shape. */
export function normalizeGatewayToolCall(c, i) {
  const fn = c?.function || c;
  let args = fn?.arguments ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { _raw: scrubText(args, 300) }; } }
  return { id: String(c?.id || `call_${i + 1}`), name: String(fn?.name || "").slice(0, 120), arguments: args && typeof args === "object" ? args : {} };
}

export class Base44GatewayProvider {
  constructor(base44, { fetchImpl = null } = {}) {
    this.base44 = base44;
    this.id = GATEWAY_PROVIDER_ID;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }
  supportsTools() { return true; }
  getModelInfo() { return null; }

  async generate({ model, system = "", messages = [], tools = null, timeoutMs = 60000, fileUrls = null }) {
    let conn;
    try { conn = this.base44.asServiceRole.aiGateway.connection(); }
    catch (e) { throw gwError("PROVIDER_UNAVAILABLE", `AI Gateway connection unavailable: ${scrubText(e?.message || e, 120)}`, true); }
    if (!conn?.baseURL || !conn?.token) throw gwError("PROVIDER_UNAVAILABLE", "AI Gateway connection is not provisioned (no baseURL/token)", true);
    // The endpoint is the platform's own `connection()` output — not an admin-configured URL —
    // so it is used as returned, exactly like every other platform-managed AI surface.
    const chat = [];
    if (system) chat.push({ role: "system", content: system });
    for (const m of messages || []) chat.push(m);
    // Reference images ride along as an image-parts message, only when present — a text-only
    // request produces the exact same body as before.
    if (fileUrls?.length) {
      chat.push({ role: "user", content: [{ type: "text", text: "Reference images attached to the request." }, ...fileUrls.map((url) => ({ type: "image_url", image_url: { url } }))] });
    }
    const body = {
      model: model.name || model.model_id || model.id,
      messages: chat,
      ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: "auto" } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || 60000));
    let res;
    try {
      res = await this.fetch(`${String(conn.baseURL).replace(/\/$/, "")}/chat/completions`, {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e?.name === "AbortError") throw gwError("PROVIDER_TIMEOUT", `AI Gateway timed out after ${timeoutMs}ms`, true);
      throw gwError("PROVIDER_UNAVAILABLE", `AI Gateway network failure: ${scrubText(e?.message || e, 120)}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw normalizeGatewayHttpError(res.status, await res.text().catch(() => ""));
    let data;
    try { data = await res.json(); } catch { throw gwError("PROVIDER_ERROR", "AI Gateway returned a malformed response body", false); }
    const msg = data?.choices?.[0]?.message;
    if (!msg || typeof msg !== "object") {
      // Fail closed: an unsupported response shape is terminal for this attempt.
      throw gwError("PROVIDER_ERROR", "AI Gateway returned an unsupported response shape (no message)", false, { reason: "UNSUPPORTED_RESPONSE_SHAPE" });
    }
    // Fail closed on an unsupported tool-call shape: a tools request answered with neither tool
    // calls nor content, or tool calls missing a tool name, is terminal — never guessed into an
    // action.
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (Array.isArray(tools) && tools.length) {
      if (!toolCalls.length && (msg.content == null || msg.content === "")) {
        throw gwError("PROVIDER_ERROR", "AI Gateway returned neither tool calls nor content for a tools request", false, { reason: "UNSUPPORTED_TOOL_SHAPE" });
      }
      if (toolCalls.some((c) => !(c?.function?.name || c?.name))) {
        throw gwError("PROVIDER_ERROR", "AI Gateway returned an unsupported tool-call shape (missing tool name)", false, { reason: "UNSUPPORTED_TOOL_SHAPE" });
      }
    }
    const normalized = toolCalls.slice(0, 50).map(normalizeGatewayToolCall);
    const output = typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);
    // Canonical usage when the gateway reports one (OpenAI names → the economics engine's
    // canonical branch); missing usage is labelled `estimated` exactly like every other provider
    // that reports none.
    const reported = data.usage ? normalizeUsage("openai", data) : null;
    const usage = reported?.usage_source === "provider"
      ? reported
      : estimateUsage({ promptText: JSON.stringify({ system, messages: messages || [], images: fileUrls || [] }), outputText: JSON.stringify({ content: output, tool_calls: normalized }) });
    return {
      output, usage, rawUsage: data.usage || null,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      tokensEstimated: usage.usage_source !== "provider",
      tool_calls: normalized,
    };
  }

  async stream() {
    throw gwError("STREAMING_UNSUPPORTED", "Streaming is not supported by the AI Gateway; progress is streamed via run steps like every other gateway model.", false);
  }
}