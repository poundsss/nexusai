// Built-in in-app agent web search (the `google_search` tool) — a provider-agnostic adapter
// with Tavily as the first provider.
//
// Base44 documents that deployed in-app agents can search the web; the tool's NAME
// (`google_search`) is the documented surface. Base44 publishes NO provider, NO request
// arguments beyond the name, NO result shape and NO per-search tariff (all UNKNOWN) — nothing
// here claims parity for them: the adapter contract, the argument set (`query`) and the
// normalized result shape (title, url, content) are this platform's own minimal form, and no
// rate is invented (integrationCharges.ts keeps unpriced external calls free; the turn's
// existing per-message model billing is unchanged).
//
// Fail-closed: with no provider key configured the search refuses deterministically
// (WEB_SEARCH_NOT_CONFIGURED) — and the agent runtime never advertises the tool in that state.
// The call is bounded: a hard timeout, a bounded query, a bounded result count and a hard cap
// on the total payload handed back to the model. The adapter never throws — the agent step
// path turns every failure into a safe observation.
import { secrets } from "base44:runtime";
import { scrubText } from "./tracing.ts";

export const WEB_SEARCH_PROVIDER = "tavily";
export const TAVILY_API_KEY_SECRET = "TAVILY_API_KEY";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export const WEB_SEARCH_LIMITS = {
  TIMEOUT_MS: 10000,             // hard per-call bound — a search never stalls an agent turn
  MAX_RESULTS: 5,                // normalized results returned at most
  RESULT_TITLE_CHARS: 200,       // one result's title, scrubbed
  RESULT_URL_CHARS: 500,         // one result's URL, scrubbed
  RESULT_CONTENT_CHARS: 500,     // one result's snippet/content, scrubbed
  QUERY_CHARS: 400,              // the search terms, scrubbed
  TOTAL_RESULT_CHARS: 1800,      // hard cap on the whole JSON block handed to the model
                                 // (inside the step observation's own MAX_OBSERVATION_CHARS)
};

const readSecret = (name) => { try { const v = secrets.get(name); return v ? String(v) : null; } catch { return null; } };

/** Whether a web-search provider is configured: an explicit test keyProvider override, else the
 *  app's own TAVILY_API_KEY secret. Cheap, synchronous, no network. */
export function isWebSearchConfigured(overrides = null) {
  if (overrides && typeof overrides.keyProvider === "function") return true;
  return !!readSecret(TAVILY_API_KEY_SECRET);
}

// --- the provider adapter contract -------------------------------------------
//
//   provider = { id, search(input, { apiKey, fetchImpl, timeoutMs }) }
//     input    { query: string } — the ONLY argument (Base44's real argument set is UNKNOWN)
//     returns  { results: [{ title, url, content }] } — normalized, already bounded
//     throws   anything — runWebSearch() catches and normalizes, so the agent step path never
//              sees an exception from a search.

/** Tavily — first provider. One POST to the documented search endpoint; results normalized. */
export const tavilyWebSearchProvider = {
  id: WEB_SEARCH_PROVIDER,
  async search({ query }, { apiKey, fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = WEB_SEARCH_LIMITS.TIMEOUT_MS } = {}) {
    if (!apiKey) throw Object.assign(new Error("no provider key"), { code: "WEB_SEARCH_NOT_CONFIGURED" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    let res;
    try {
      res = await fetchImpl(TAVILY_SEARCH_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query, max_results: WEB_SEARCH_LIMITS.MAX_RESULTS, search_depth: "basic" }),
      });
    } catch (e) {
      clearTimeout(timer);
      if (e?.name === "AbortError") throw Object.assign(new Error(`web search timed out after ${timeoutMs}ms`), { code: "WEB_SEARCH_TIMEOUT" });
      throw Object.assign(new Error(`web search network failure: ${scrubText(String(e?.message || e), 120)}`), { code: "WEB_SEARCH_PROVIDER_ERROR" });
    }
    clearTimeout(timer);
    if (!res.ok) {
      throw Object.assign(new Error(`web search provider returned HTTP ${res.status}`), { code: "WEB_SEARCH_PROVIDER_ERROR" });
    }
    let data;
    try { data = await res.json(); } catch {
      throw Object.assign(new Error("web search provider returned a malformed body"), { code: "WEB_SEARCH_INVALID_RESPONSE" });
    }
    if (!data || !Array.isArray(data.results)) {
      throw Object.assign(new Error("web search provider response has no results array"), { code: "WEB_SEARCH_INVALID_RESPONSE" });
    }
    const results = data.results.slice(0, WEB_SEARCH_LIMITS.MAX_RESULTS).map((r) => ({
      title: scrubText(String((r || {}).title ?? ""), WEB_SEARCH_LIMITS.RESULT_TITLE_CHARS),
      url: scrubText(String((r || {}).url ?? ""), WEB_SEARCH_LIMITS.RESULT_URL_CHARS),
      content: scrubText(String((r || {}).content ?? ""), WEB_SEARCH_LIMITS.RESULT_CONTENT_CHARS),
    })).filter((r) => r.url || r.content);
    return { results };
  },
};

/** The registered providers, in preference order. Adding a provider is an array entry here. */
export const WEB_SEARCH_PROVIDERS = [tavilyWebSearchProvider];

/**
 * Runs ONE bounded web search. NEVER throws: the result is
 *   { ok: true, provider, results } or { ok: false, code, message }
 * and the message is a safe, truncated human string for an observation. Deterministic
 * refusals: no key (fail closed), a missing or oversized query.
 */
export async function runWebSearch({ query, keyProvider = null, fetchImpl = null, timeoutMs = null, maxResults = null } = {}) {
  const q = scrubText(String(query ?? ""), WEB_SEARCH_LIMITS.QUERY_CHARS).trim();
  if (!q) return { ok: false, code: "WEB_SEARCH_QUERY_REQUIRED", message: "a non-empty query is required" };
  let apiKey = null;
  try { apiKey = typeof keyProvider === "function" ? await keyProvider() : keyProvider; } catch { apiKey = null; }
  if (!apiKey) apiKey = readSecret(TAVILY_API_KEY_SECRET);
  if (!apiKey) {
    return { ok: false, code: "WEB_SEARCH_NOT_CONFIGURED", message: `web search is not configured (set the ${TAVILY_API_KEY_SECRET} secret)` };
  }
  const provider = WEB_SEARCH_PROVIDERS[0]; // Tavily is the first provider; later entries extend this
  try {
    const out = await provider.search(
      { query: q },
      { apiKey, ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) },
    );
    // Hard cap on the whole payload handed to the model: drop trailing results until it fits.
    let results = (out.results || []).slice(0, Number(maxResults) > 0 ? Number(maxResults) : WEB_SEARCH_LIMITS.MAX_RESULTS);
    while (results.length > 1 && JSON.stringify(results).length > WEB_SEARCH_LIMITS.TOTAL_RESULT_CHARS) results = results.slice(0, -1);
    return { ok: true, provider: provider.id, results };
  } catch (e) {
    return { ok: false, code: e?.code || "WEB_SEARCH_PROVIDER_ERROR", message: scrubText(String(e?.message || e), 200) };
  }
}