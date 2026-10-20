// Model Catalog: the single source of truth for which models exist, what they can do, and
// what they cost. Two rules make it commercial-grade:
//
//   1. No price is hardcoded anywhere else in the platform. Callers pass a model_id and a
//      pricing version; the numbers live only here (and in the ModelCatalogEntry mirror).
//   2. Pricing is APPEND-ONLY. Changing a price adds a new pricing version and closes the
//      previous one with `effective_until` — it never edits an existing version. A historical
//      AI operation stores the version it was charged under, so repricing it later reproduces
//      exactly what the user was charged, even years after the price changed.

export const CATALOG_SCHEMA_VERSION = 1;

const price = (pricing_version, effective_from, input_per_mtok, output_per_mtok, extra = {}) => ({
  pricing_version,
  currency: "USD",
  input_per_mtok,
  output_per_mtok,
  cached_input_per_mtok: extra.cached ?? null,
  reasoning_per_mtok: extra.reasoning ?? null,
  effective_from,
  effective_until: extra.until ?? null,
});

// Every model reachable through the platform's gateway. `provider` is who bills;
// `gateway_provider` is the adapter used to execute.
export const MODEL_CATALOG = [
  {
    provider: "google",
    gateway_provider: "base44-core",
    model_id: "gemini-3-flash",
    provider_model_name: "gemini_3_flash",
    display_name: "Gemini 3 Flash",
    model_family: "gemini-3",
    quality_tier: "fast",
    capabilities: ["text", "json", "code", "vision", "structured_output", "web_search"],
    context_window: 1000000,
    max_output_tokens: 65536,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: false,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    // DOCUMENTED (Base44 model retirement): absent from the current preset table; a call naming
    // it is routed by the platform to a close current model. Kept callable and pricable for
    // history and for existing pinned configurations.
    retired: true,
    replaced_by: "gemini-3-8-flash",
    routing: { latency_class: "fast", expected_latency_ms: 9000, weight: 100, fallback_model_ids: ["gpt-5-mini", "claude-sonnet-5"] },
    pricing: [price("gemini-3-flash@2026-01-01", "2026-01-01T00:00:00.000Z", 0.15, 0.6, { cached: 0.0375 })],
  },
  {
    provider: "openai",
    gateway_provider: "base44-core",
    model_id: "gpt-5-mini",
    provider_model_name: "gpt_5_mini",
    display_name: "GPT-5 Mini",
    model_family: "gpt-5",
    quality_tier: "fast",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 400000,
    max_output_tokens: 128000,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    // DOCUMENTED (Base44 model retirement): absent from the current preset table.
    retired: true,
    replaced_by: "gpt-6-luna",
    routing: { latency_class: "fast", expected_latency_ms: 12000, weight: 80, fallback_model_ids: ["gemini-3-flash"] },
    pricing: [price("gpt-5-mini@2026-01-01", "2026-01-01T00:00:00.000Z", 0.25, 2, { cached: 0.025, reasoning: 2 })],
  },
  {
    provider: "anthropic",
    gateway_provider: "base44-core",
    model_id: "claude-sonnet-5",
    provider_model_name: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    model_family: "claude-5",
    quality_tier: "standard",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 200000,
    max_output_tokens: 64000,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    routing: { latency_class: "standard", expected_latency_ms: 30000, weight: 60, fallback_model_ids: ["gemini-3-flash"] },
    pricing: [
      // Closed version, kept forever so operations charged in H1 2026 still reprice exactly.
      price("claude-sonnet-5@2026-01-01", "2026-01-01T00:00:00.000Z", 3.5, 17.5, { cached: 0.35, reasoning: 17.5, until: "2026-06-01T00:00:00.000Z" }),
      price("claude-sonnet-5@2026-06-01", "2026-06-01T00:00:00.000Z", 3, 15, { cached: 0.3, reasoning: 15 }),
    ],
  },
  {
    provider: "anthropic",
    gateway_provider: "base44-core",
    model_id: "claude-opus-5",
    provider_model_name: "claude_opus_5",
    display_name: "Claude Opus 5",
    model_family: "claude-5",
    quality_tier: "advanced",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 200000,
    max_output_tokens: 64000,
    supports_streaming: false,
    supports_tools: false,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    // Verified callable; kept out of automatic routing purely on cost. It still prices
    // historical operations and can be selected explicitly by a best-quality request.
    active: false,
    availability: "ga",
    // DOCUMENTED (Base44 model retirement): absent from the current preset table.
    retired: true,
    replaced_by: "claude-opus-5-5",
    routing: { latency_class: "slow", expected_latency_ms: 60000, weight: 10, fallback_model_ids: ["claude-sonnet-5"] },
    pricing: [price("claude-opus-5@2026-01-01", "2026-01-01T00:00:00.000Z", 15, 75, { cached: 1.5, reasoning: 75 })],
  },
  // --- DOCUMENTED (Base44 Supported Models, docs.base44.com/developers/backend/resources/models):
  // the eight current preset models + `automatic`. Every entry below is present in the runtime
  // AI Gateway's model list (verified against GET /models) and priced at the vendor's published
  // standard rates (OpenAI / Anthropic / Google / Base44.com model pages, verified 2026-10-06).
  // These preset ids are NOT in InvokeLLM's accepted model list, so they execute through the
  // OpenAI-compatible AI Gateway adapter on the SAME metered surface.
  // builder_picker mirrors Base44's documented Builder chat picker ("Choosing your model"):
  // Auto mode + Base 1, Sonnet 5.5, Opus 5.5, Gemini 3.8 Flash, GPT-6.1 Sol, GPT 6 Astra,
  // Fable 5.1. GPT-6 Luna and Base 1 are documented preset/agent models but are NOT listed in
  // that picker, so they are selectable as agent pins / API models and hidden from the picker.
  {
    provider: "anthropic",
    gateway_provider: "base44-gateway",
    model_id: "claude-opus-5-5",
    provider_model_name: "claude_opus_5_5",
    display_name: "Claude Opus 5.5",
    model_family: "claude-5",
    quality_tier: "advanced",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 1000000,
    max_output_tokens: 128000,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    builder_picker: true,
    routing: { latency_class: "slow", expected_latency_ms: 45000, weight: 40, fallback_model_ids: ["claude-sonnet-5"] },
    pricing: [price("claude-opus-5-5@2026-09-01", "2026-09-01T00:00:00.000Z", 4, 20, { cached: 0.2 })],
  },
  {
    provider: "google",
    gateway_provider: "base44-gateway",
    model_id: "gemini-3-8-flash",
    provider_model_name: "gemini_3_8_flash",
    display_name: "Gemini 3.8 Flash",
    model_family: "gemini-3-8",
    quality_tier: "fast",
    capabilities: ["text", "json", "code", "vision", "structured_output", "web_search"],
    context_window: 1048576,
    max_output_tokens: 65536,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: false,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    builder_picker: true,
    routing: { latency_class: "fast", expected_latency_ms: 9000, weight: 90, fallback_model_ids: ["gpt-6-luna", "claude-sonnet-5"] },
    // Introductory pricing through 2026-12-31 (vendor-published), standard from 2027-01-01 —
    // appended, never edited, per the append-only pricing rule.
    pricing: [
      price("gemini-3-8-flash@2026-09-01", "2026-09-01T00:00:00.000Z", 0.75, 3.75, { cached: 0.075, until: "2027-01-01T00:00:00.000Z" }),
      price("gemini-3-8-flash@2027-01-01", "2027-01-01T00:00:00.000Z", 1.5, 7.5, { cached: 0.15 }),
    ],
  },
  {
    provider: "openai",
    gateway_provider: "base44-gateway",
    model_id: "gpt-6-sol",
    provider_model_name: "gpt_6_sol",
    display_name: "GPT-6.1 Sol",
    model_family: "gpt-6",
    quality_tier: "standard",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 1050000,
    max_output_tokens: 128000,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    builder_picker: true,
    routing: { latency_class: "standard", expected_latency_ms: 20000, weight: 60, fallback_model_ids: ["gpt-6-luna", "gemini-3-8-flash"] },
    pricing: [price("gpt-6-sol@2026-09-01", "2026-09-01T00:00:00.000Z", 2, 10, { cached: 0.1 })],
  },
  {
    provider: "openai",
    gateway_provider: "base44-gateway",
    model_id: "gpt-6-astra",
    provider_model_name: "gpt_6_astra",
    display_name: "GPT-6 Astra",
    model_family: "gpt-6",
    quality_tier: "advanced",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 1050000,
    max_output_tokens: 128000,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    builder_picker: true,
    routing: { latency_class: "slow", expected_latency_ms: 45000, weight: 20, fallback_model_ids: ["gpt-6-sol"] },
    pricing: [price("gpt-6-astra@2026-09-01", "2026-09-01T00:00:00.000Z", 10, 50, { cached: 1 })],
  },
  {
    provider: "anthropic",
    gateway_provider: "base44-gateway",
    model_id: "claude-fable-5-1",
    provider_model_name: "claude_fable_5_1",
    display_name: "Claude Fable 5.1",
    model_family: "claude-5",
    quality_tier: "advanced",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 1000000,
    max_output_tokens: 128000,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    builder_picker: true,
    routing: { latency_class: "slow", expected_latency_ms: 45000, weight: 20, fallback_model_ids: ["claude-opus-5-5"] },
    pricing: [price("claude-fable-5-1@2026-09-01", "2026-09-01T00:00:00.000Z", 10, 50, { cached: 0.25 })],
  },
  {
    provider: "openai",
    gateway_provider: "base44-gateway",
    model_id: "gpt-6-luna",
    provider_model_name: "gpt_6_luna",
    display_name: "GPT-6 Luna",
    model_family: "gpt-6",
    quality_tier: "fast",
    capabilities: ["text", "json", "code", "vision", "structured_output", "reasoning"],
    context_window: 1050000,
    max_output_tokens: 128000,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: true,
    supports_audio: false,
    supports_reasoning: true,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    builder_picker: false,
    routing: { latency_class: "fast", expected_latency_ms: 9000, weight: 80, fallback_model_ids: ["gemini-3-8-flash"] },
    pricing: [price("gpt-6-luna@2026-09-01", "2026-09-01T00:00:00.000Z", 0.1, 0.5, { cached: 0.01 })],
  },
  {
    // Base 1 — Base44's first-party preset, served by the runtime gateway (owned_by "zai"),
    // documented as a balanced general-purpose choice. Text-focused per the vendor spec.
    provider: "base44",
    gateway_provider: "base44-gateway",
    model_id: "Base 1",
    provider_model_name: "Base 1_2",
    display_name: "Base 1",
    model_family: "Base 1",
    quality_tier: "standard",
    capabilities: ["text", "json", "code", "structured_output"],
    context_window: 1048576,
    max_output_tokens: 131072,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: false,
    supports_audio: false,
    supports_reasoning: false,
    supports_structured_output: true,
    supports_cached_input: true,
    active: true,
    availability: "ga",
    builder_picker: false,
    routing: { latency_class: "standard", expected_latency_ms: 20000, weight: 60, fallback_model_ids: ["gpt-6-luna"] },
    pricing: [price("Base 1@2026-09-01", "2026-09-01T00:00:00.000Z", 1.4, 4.4, { cached: 0.26 })],
  },
  {
    // Nexus (#40): the platform's first-party model, behind the same gateway contract as every
    // external model. Declared limits are the INFERENCE CONTRACT's limits, not a trained model's
    // measured behaviour. Inactive until inference is provisioned, the cost profile is established
    // and real benchmark evidence exists — so automatic routing can never pick a model that cannot
    // answer, and no quality is implied by its presence here.
    provider: "nexus",
    gateway_provider: "nexus",
    model_id: "nexus-1",
    provider_model_name: "nexus-1",
    display_name: "Nexus 1",
    model_family: "nexus",
    model_version: "1.0.0-preview",
    provider_version: "nexus-inference/v1",
    quality_tier: "standard",
    quality_tier_basis: "unverified",
    capabilities: ["text", "json", "code", "structured_output", "tools"],
    context_window: 128000,
    max_output_tokens: 16384,
    supports_streaming: false,
    supports_tools: true,
    supports_vision: false,
    supports_audio: false,
    supports_reasoning: false,
    supports_structured_output: true,
    supports_cached_input: false,
    active: false,
    availability: "preview",
    routing: { latency_class: "standard", expected_latency_ms: null, weight: 0, fallback_model_ids: ["claude-sonnet-5", "gemini-3-flash"] },
    // Unpriced by declaration: the internal cost basis is not established, so the rate is 0 and
    // says so. This is not a claim that Nexus is free — it is the absence of a price.
    pricing: [{ ...price("nexus-1@2026-09-01", "2026-09-01T00:00:00.000Z", 0, 0), cost_basis: "unpriced_internal" }],
  },
];

export const CATALOG_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.model_id, m]));

// DOCUMENTED (Base44 model retirement): retired preset ids remain callable — the platform routes
// a call naming one to a close current model. They stay pricable here (history reprices exactly)
// and each records what replaced it. Retired entries are excluded from the Builder chat picker.
export const RETIRED_MODEL_MAP: Record<string, string> = {
  "gemini-3-flash": "gemini-3-8-flash",
  "gpt-5-mini": "gpt-6-luna",
  "claude-opus-5": "claude-opus-5-5",
};

export function listModels({ includeInactive = false, catalog = MODEL_CATALOG } = {}) {
  return catalog.filter((m) => includeInactive || (m.active && m.availability !== "unavailable"));
}

export function getModel(model_id, catalog = MODEL_CATALOG) {
  const m = catalog.find((x) => x.model_id === model_id);
  if (!m) throw Object.assign(new Error(`Unknown model "${model_id}"`), { code: "UNKNOWN_MODEL", status: 400 });
  return m;
}

// Resolves the pricing row a cost must be computed against. Either an explicit historical
// version (what a stored operation does) or the version effective at a point in time.
export function resolvePricing(model_id, { pricing_version = null, at = null, catalog = MODEL_CATALOG } = {}) {
  const model = getModel(model_id, catalog);
  const versions = model.pricing || [];
  if (pricing_version) {
    const hit = versions.find((p) => p.pricing_version === pricing_version);
    if (!hit) throw Object.assign(new Error(`Unknown pricing version "${pricing_version}" for ${model_id}`), { code: "UNKNOWN_PRICING_VERSION", status: 400 });
    return hit;
  }
  const t = at ? Date.parse(at) : Date.now();
  const hit = versions.find((p) => Date.parse(p.effective_from) <= t && (!p.effective_until || Date.parse(p.effective_until) > t));
  if (!hit) throw Object.assign(new Error(`No pricing effective for ${model_id} at ${new Date(t).toISOString()}`), { code: "NO_EFFECTIVE_PRICING", status: 500 });
  return hit;
}

export const currentPricingVersion = (model_id, opts) => resolvePricing(model_id, opts).pricing_version;

// Capability matching. Returns accepted candidates AND the reason each rejection failed —
// the router must be able to explain internally why a cheaper model was not chosen.
export function matchModels(requirements = {}, { includeInactive = false, catalog = MODEL_CATALOG } = {}) {
  const req = requirements || {};
  const needCaps = req.capabilities || [];
  const candidates = [];
  const rejected = [];
  for (const m of listModels({ includeInactive, catalog })) {
    const missing = needCaps.filter((c) => !(m.capabilities || []).includes(c));
    if (missing.length) { rejected.push({ model_id: m.model_id, reason: `missing capability: ${missing.join(", ")}` }); continue; }
    if (req.needs_tools && !m.supports_tools) { rejected.push({ model_id: m.model_id, reason: "no tool support" }); continue; }
    if (req.needs_vision && !m.supports_vision) { rejected.push({ model_id: m.model_id, reason: "no vision support" }); continue; }
    if (req.needs_audio && !m.supports_audio) { rejected.push({ model_id: m.model_id, reason: "no audio support" }); continue; }
    if (req.needs_reasoning && !m.supports_reasoning) { rejected.push({ model_id: m.model_id, reason: "no reasoning support" }); continue; }
    if (req.needs_streaming && !m.supports_streaming) { rejected.push({ model_id: m.model_id, reason: "no streaming support" }); continue; }
    if (req.needs_structured_output && !m.supports_structured_output) { rejected.push({ model_id: m.model_id, reason: "no structured output" }); continue; }
    if (req.min_context && (m.context_window || 0) < req.min_context) { rejected.push({ model_id: m.model_id, reason: `context window ${m.context_window} < required ${req.min_context}` }); continue; }
    if (req.min_output_tokens && (m.max_output_tokens || 0) < req.min_output_tokens) { rejected.push({ model_id: m.model_id, reason: `max output ${m.max_output_tokens} < required ${req.min_output_tokens}` }); continue; }
    candidates.push(m);
  }
  return { candidates, rejected };
}

// --- persistence mirror -------------------------------------------------------
// The catalog is code-defined (so it is deterministic and reviewable) and mirrored into
// ModelCatalogEntry rows for admin visibility and pricing history. Syncing APPENDS unseen
// pricing versions and never mutates a stored one.

export async function syncCatalog(base44) {
  const existing = await base44.entities.ModelCatalogEntry.list("-updated_date", 500);
  const byId = new Map(existing.map((r) => [r.model_id, r]));
  let created = 0, updated = 0, unchanged = 0, pricing_added = 0;
  for (const m of MODEL_CATALOG) {
    const row = byId.get(m.model_id);
    if (!row) {
      await base44.entities.ModelCatalogEntry.create({ ...m, catalog_version: 1 });
      created++;
      continue;
    }
    const storedVersions = new Set((row.pricing || []).map((p) => p.pricing_version));
    const added = (m.pricing || []).filter((p) => !storedVersions.has(p.pricing_version));
    // Stored versions are preserved byte-for-byte; only new ones are appended.
    const mergedPricing = [...(row.pricing || []), ...added];
    const same =
      !added.length &&
      row.active === m.active &&
      row.availability === m.availability &&
      row.provider_model_name === m.provider_model_name &&
      (row.capabilities || []).join(",") === m.capabilities.join(",") &&
      row.context_window === m.context_window;
    if (same) { unchanged++; continue; }
    await base44.entities.ModelCatalogEntry.update(row.id, { ...m, pricing: mergedPricing, catalog_version: (row.catalog_version || 1) + 1 });
    updated++;
    pricing_added += added.length;
  }
  return { created, updated, unchanged, pricing_added };
}

// Runtime read path: stored rows when the mirror exists (so an admin can deactivate a model
// without a deploy), otherwise the code catalog. Pricing always falls back to the code
// definition for versions the mirror has not seen.
export async function loadCatalog(base44) {
  const rows = await base44.entities.ModelCatalogEntry.list("-updated_date", 500).catch(() => []);
  if (!rows.length) return MODEL_CATALOG;
  return MODEL_CATALOG.map((m) => {
    const row = rows.find((r) => r.model_id === m.model_id);
    if (!row) return m;
    const versions = [...(m.pricing || [])];
    for (const p of row.pricing || []) if (!versions.some((v) => v.pricing_version === p.pricing_version)) versions.push(p);
    return { ...m, active: row.active !== false && m.active, availability: row.availability || m.availability, pricing: versions };
  });
}