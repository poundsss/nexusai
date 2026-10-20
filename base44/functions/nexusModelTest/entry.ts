// Focused certification for #40 — Nexus as a first-class Model Gateway provider.
//
// Exercises the REAL gateway, catalog, router, health breaker and charging path. The Nexus wire is
// driven through the adapter's fetch hook so timeout, rejection, structured-output and tool-call
// behaviour are deterministic; nothing fabricates a trained model or a quality number.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { createGateway, routeModel, classifyProviderError, MODEL_REGISTRY } from "../../shared/modelGateway.ts";
import { MODEL_CATALOG, matchModels, resolvePricing, getModel } from "../../shared/modelCatalog.ts";
import { resetProviderHealth, markProviderUnhealthy, isProviderHealthy, providerHealth } from "../../shared/providerHealth.ts";
import { NexusProvider, NEXUS_MODEL_ID, NEXUS_PROVIDER, nexusHealth, nexusStatus, nexusCatalogStatus, normalizeNexusHttpError, validateStructuredOutput } from "../../shared/nexusProvider.ts";
import { settleUsage } from "../../shared/aiOperations.ts";
import { normalizeUsage, computeProviderCost } from "../../shared/economics.ts";
import { resolveCandidate } from "../../shared/candidateEvaluation.ts";

const SECRET = "sk_live_NEXUSLEAK1234567890";
const nexus = () => MODEL_REGISTRY.find((m) => m.model_id === NEXUS_MODEL_ID);
const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scripted = (fn) => ({ id: "scripted", supportsTools: () => false, getModelInfo: () => null, async generate({ model: m }) { const step = fn(m) || {}; if (step.error) throw step.error; return { output: { ok: true, model_id: m.model_id }, usage: { input_tokens: 10, output_tokens: 5, usage_source: "estimated" }, inputTokens: 10, outputTokens: 5, tokensEstimated: true }; } });
const provisioned = (fetchImpl, svc) => new NexusProvider(svc, { endpoint: "https://nexus.internal.test", apiKey: "nexus-test-key", fetchImpl });
const req = { system: "s", messages: [{ role: "user", content: "hello" }], timeoutMs: 8000 };

export default async function (request) {
  const base44 = createClientFromRequest(request);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let workspace = null, project = null;
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    resetProviderHealth();

    // ---------------------------------------------------------------- registration
    const entry = nexus();
    const cat = getModel(NEXUS_MODEL_ID);
    h.check("1 nexus is registered in the model registry", !!entry && entry.provider === NEXUS_PROVIDER && entry.upstream_provider === NEXUS_PROVIDER && entry.model_version === "1.0.0-preview" && entry.availability === "preview",
      `${entry?.model_id} · gateway ${entry?.provider} · v${entry?.model_version}`);
    h.check("1b capabilities/context/tool/structured-output declared through the catalog contract",
      cat.supports_tools === true && cat.supports_structured_output === true && cat.supports_streaming === false && cat.context_window === 128000 && cat.capabilities.includes("tools") && entry.supportsTools === true && entry.supportsStructuredOutput === true && entry.supportsStreaming === false,
      `caps ${cat.capabilities.join(",")} · ctx ${cat.context_window}`);
    // "Untouched" is now structural, not count-based: the nexus addition may not change any
    // external model's provider or gateway adapter, and the registry stays a 1:1 mirror.
    h.check("1c external providers untouched",
      MODEL_CATALOG.filter((m) => m.provider === NEXUS_PROVIDER).length === 1
        && MODEL_CATALOG.filter((m) => m.provider !== NEXUS_PROVIDER).every((m) => m.gateway_provider !== NEXUS_PROVIDER)
        && MODEL_REGISTRY.length === MODEL_CATALOG.length,
      `${MODEL_CATALOG.length} catalog models, 1 nexus, ${MODEL_REGISTRY.length} mirrored`);
    const toolMatch = matchModels({ needs_tools: true }, { includeInactive: true });
    h.check("1d capability matching sees nexus tool support like any other model", toolMatch.candidates.some((m) => m.model_id === NEXUS_MODEL_ID) && toolMatch.rejected.every((r) => r.model_id !== NEXUS_MODEL_ID),
      `tool-capable: ${toolMatch.candidates.map((m) => m.model_id).join(",")}`);
    const auto = routeModel({ mode: "build", prompt: "add a notes page", fileCount: 2 });
    const preferred = routeModel({ mode: "build", prompt: "add a notes page", fileCount: 2, prefer_model_id: NEXUS_MODEL_ID });
    h.check("1e inactive nexus is never chosen by automatic routing; explicit preference is refused explainably",
      auto.model.model_id !== NEXUS_MODEL_ID && preferred.model.model_id !== NEXUS_MODEL_ID && preferred.decision.rejected.some((r) => r.model_id === NEXUS_MODEL_ID),
      `auto → ${auto.model.model_id}; preferred nexus → ${preferred.model.model_id}`);

    // ---------------------------------------------------------------- invocation (provisioned wire)
    const calls = [];
    const okFetch = async (url, init) => { calls.push({ url, init }); const body = JSON.parse(init.body); return json({ output: body.response_schema ? { title: "Note", ok: true } : "plain answer", usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 }, tool_calls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "src/a.js" }) }], model_version: "1.0.0-preview" }); };
    {
      const gw = createGateway(svc, { providerOverrides: { [NEXUS_PROVIDER]: provisioned(okFetch, svc) } });
      const res = await gw.generate(entry, req);
      const sent = JSON.parse(calls[0].init.body);
      h.check("2 nexus invocation goes through the same gateway contract", res.output === "plain answer" && res.model_used.model_id === NEXUS_MODEL_ID && !res.fallback_from && calls[0].url.endsWith("/v1/generate") && sent.contract_version === "nexus-inference/v1" && sent.model_version === "1.0.0-preview",
        `POST ${calls[0].url} · contract ${sent.contract_version}`);
      h.check("3 provider-reported usage is consumed as measured usage", res.usage.usage_source === "provider" && res.inputTokens === 120 && res.outputTokens === 40 && res.tokensEstimated === false && normalizeUsage(NEXUS_PROVIDER, { usage: { input_tokens: 1, output_tokens: 2 } }).total_tokens === 3,
        JSON.stringify(res.usage));
      h.check("6 tool calls are normalized", res.tool_calls.length === 1 && res.tool_calls[0].name === "write_file" && res.tool_calls[0].arguments.path === "src/a.js", JSON.stringify(res.tool_calls));
      h.check("6b breaker records the healthy call", isProviderHealthy(NEXUS_PROVIDER) && !providerHealth()[NEXUS_PROVIDER], "healthy after success");
    }
    // ---------------------------------------------------------------- structured output
    {
      const gw = createGateway(svc, { providerOverrides: { [NEXUS_PROVIDER]: provisioned(okFetch, svc) } });
      const res = await gw.generate(entry, { ...req, jsonSchema: { type: "object", required: ["title"] } });
      h.check("5 structured output honours the schema contract", typeof res.output === "object" && res.output.title === "Note", JSON.stringify(res.output));
      const bad = provisioned(async () => json({ output: { ok: true }, usage: { input_tokens: 5, output_tokens: 1 } }), svc);
      const gw2 = createGateway(svc, { providerOverrides: { [NEXUS_PROVIDER]: bad, "base44-core": scripted(() => ({})) } });
      let thrown = null;
      try { await gw2.generate(entry, { ...req, jsonSchema: { type: "object", required: ["title"] }, maxAttempts: 3 }); } catch (e) { thrown = e; }
      h.check("5b invalid structured output is terminal: no retry, no fallback", thrown?.code === "STRUCTURED_OUTPUT_INVALID" && thrown.retryable === false && classifyProviderError(thrown).retryable === false,
        `${thrown?.code}: ${thrown?.message}`);
      let parseErr = null; try { validateStructuredOutput("not json", { required: [] }); } catch (e) { parseErr = e; }
      h.check("5c non-JSON structured output is rejected", parseErr?.code === "STRUCTURED_OUTPUT_INVALID", parseErr?.message);
    }
    // ---------------------------------------------------------------- usage metering
    workspace = await svc.entities.Workspace.create({ name: `nexus-cert-${Date.now()}`, owner_id: user.id, status: "active", credits_balance: 500 });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: "nexus-cert", framework: "preact-htm", status: "draft", version_count: 0 });
    {
      const run = await svc.entities.AIRun.create({ project_id: project.id, status: "COMPLETED", mode: "default", phase: "done", prompt: "cert", model: NEXUS_MODEL_ID });
      const settled = await settleUsage(svc, { workspace_id: workspace.id, user_id: user.id, project_id: project.id, run_id: run.id, model: entry, usage: { input_tokens: 120, output_tokens: 40 }, usage_source: "provider", idempotency_key: `run:${run.id}`, duration_ms: 900 });
      const again = await settleUsage(svc, { workspace_id: workspace.id, user_id: user.id, project_id: project.id, run_id: run.id, model: entry, usage: { input_tokens: 120, output_tokens: 40 }, usage_source: "provider", idempotency_key: `run:${run.id}` });
      const op = settled.operation;
      const pricing = resolvePricing(NEXUS_MODEL_ID);
      h.check("4 usage is metered through the existing AIOperation path", op && op.provider === NEXUS_PROVIDER && op.gateway_provider === NEXUS_PROVIDER && op.model_id === NEXUS_MODEL_ID && op.input_tokens === 120 && op.output_tokens === 40 && op.usage_source === "provider" && op.status === "completed" && op.pricing_version === pricing.pricing_version,
        `op ${op?.id} · ${op?.total_tokens} tokens · pricing ${op?.pricing_version}`);
      h.check("4b cost profile is honest: unpriced internal cost recorded as 0, not invented", pricing.cost_basis === "unpriced_internal" && op.provider_cost === 0 && op.credits_charged === 0 && computeProviderCost({ model_id: NEXUS_MODEL_ID, usage: { input_tokens: 1e6, output_tokens: 1e6 } }).provider_cost === 0 && nexusCatalogStatus().cost_profile.priced === false,
        `cost_basis ${pricing.cost_basis}`);
      h.check("4c settlement is exactly-once and ledger-neutral", again.duplicate === true && (await svc.entities.AIOperation.filter({ run_id: run.id }, "created_date", 5)).length === 1 && (await svc.entities.CreditLedgerEntry.filter({ workspace_id: workspace.id }, "created_date", 5)).length === 0,
        "one operation, no second charge, no ledger movement for an unpriced model");
    }
    // ---------------------------------------------------------------- timeout / failure normalization
    {
      resetProviderHealth();
      const hanging = provisioned((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))), svc);
      const started = Date.now();
      let thrown = null; try { await hanging.generate({ model: entry, ...req, timeoutMs: 1500 }); } catch (e) { thrown = e; }
      h.check("7 timeout is bounded and normalized", thrown?.code === "PROVIDER_TIMEOUT" && thrown.retryable === true && Date.now() - started < 5000, `${thrown?.code} after ${Date.now() - started}ms`);
      const e401 = normalizeNexusHttpError(401, JSON.stringify({ error: `bad key ${SECRET}` }));
      const e429 = normalizeNexusHttpError(429, ""), e503 = normalizeNexusHttpError(503, "upstream down"), e422 = normalizeNexusHttpError(422, "");
      h.check("7b HTTP failures map onto the gateway error vocabulary", e401.code === "PROVIDER_REJECTED" && e401.retryable === false && e429.code === "PROVIDER_UNAVAILABLE" && e429.retryable === true && e503.retryable === true && e422.retryable === false && !e401.message.includes(SECRET) && e401.message.includes("[REDACTED]"),
        `401→${e401.code} 429→${e429.code} 503→${e503.code} 422→${e422.code}`);
      const rejecting = provisioned(async () => json({ error: "unauthorized" }, 401), svc);
      const gw = createGateway(svc, { providerOverrides: { [NEXUS_PROVIDER]: rejecting, "base44-core": scripted(() => ({})) } });
      let rej = null; try { await gw.generate(entry, { ...req, maxAttempts: 3 }); } catch (e) { rej = e; }
      h.check("7c deterministic rejection does not fall back", rej?.code === "PROVIDER_REJECTED" && (rej.provider_attempts || []).length === 0, `${rej?.code}`);
    }
    // ---------------------------------------------------------------- fallback
    {
      resetProviderHealth();
      const core = scripted(() => ({}));
      const gw = createGateway(svc, { providerOverrides: { "base44-core": core } }); // REAL (unprovisioned) Nexus adapter
      const res = await gw.generate(entry, req);
      h.check("8 unprovisioned nexus fails over to a real catalog model through the fallback chain", res.fallback_from === NEXUS_MODEL_ID && res.model_used.model_id === "claude-sonnet-5" && res.provider_attempts[0]?.model_id === NEXUS_MODEL_ID && res.provider_attempts[0].error_code === "PROVIDER_UNAVAILABLE",
        `${res.provider_attempts[0]?.model_id} → ${res.model_used.model_id}`);
      const unavailable = provisioned(async () => json({ error: "overloaded" }, 503), svc);
      const gw2 = createGateway(svc, { providerOverrides: { [NEXUS_PROVIDER]: unavailable, "base44-core": core } });
      const res2 = await gw2.generate(entry, { ...req, fallbacks: ["gemini-3-flash"] });
      h.check("8b provisioned but unavailable nexus falls back to the caller's chain", res2.fallback_from === NEXUS_MODEL_ID && res2.model_used.model_id === "gemini-3-flash", `→ ${res2.model_used.model_id}`);
    }
    // ---------------------------------------------------------------- health state
    {
      resetProviderHealth();
      const before = nexusHealth();
      const unavailable = provisioned(async () => json({ error: "overloaded" }, 503), svc);
      const gw = createGateway(svc, { providerOverrides: { [NEXUS_PROVIDER]: unavailable, "base44-core": scripted(() => ({})) } });
      await gw.generate(entry, { ...req, maxAttempts: 3, fallbacks: ["gemini-3-flash"] });
      const tripped = nexusHealth({ endpoint: "https://nexus.internal.test", apiKey: "k" });
      h.check("9 health state: unprovisioned is reported, consecutive failures trip the shared breaker",
        before.state === "unprovisioned" && before.healthy === false && tripped.state === "degraded" && tripped.healthy === false && !isProviderHealthy(NEXUS_PROVIDER) && !!providerHealth()[NEXUS_PROVIDER],
        `before=${before.state} after=${tripped.state}`);
      const gated = routeModel({ mode: "build", prompt: "x", fileCount: 1 });
      h.check("9b tripped nexus breaker feeds the existing routing gate", (gated.decision.unhealthy_providers || []).some((u) => u.provider === NEXUS_PROVIDER), JSON.stringify(gated.decision.unhealthy_providers || []));
      resetProviderHealth();
      markProviderUnhealthy(NEXUS_PROVIDER, "forced");
      h.check("9c forced breaker state is visible and resets", nexusHealth({ endpoint: "e", apiKey: "k" }).state === "degraded" && (resetProviderHealth(), nexusHealth({ endpoint: "e", apiKey: "k" }).state === "healthy"), "");
    }
    // ---------------------------------------------------------------- no fabricated quality
    {
      const status = await nexusStatus(svc);
      h.check("10 no fabricated model-quality metrics", status.evidence.quality_metrics === null && status.catalog.quality_tier_basis === "unverified" && status.activation.eligible === false && status.activation.blockers.length >= 3 && status.limitations.length === 3,
        `blockers: ${status.activation.blockers.length}; evidence null: ${status.evidence.quality_metrics_reason}`);
      const cand = resolveCandidate({ model_id: NEXUS_MODEL_ID });
      h.check("10b nexus is a valid #39 candidate whose provider is catalog-resolved", cand.candidate.provider === NEXUS_PROVIDER && cand.candidate.gateway_provider === NEXUS_PROVIDER && cand.candidate.context_window === 128000, cand.candidate_id);
      h.check("10c status carries no secret material", !JSON.stringify(status).includes("nexus-test-key") && !JSON.stringify(status).includes(SECRET), "");
    }
    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    resetProviderHealth();
    if (project) { for (const name of ["AIRun", "AIOperation", "TraceEvent"]) await purgeBy(svc, name, { project_id: project.id }); await svc.entities.Project.delete(project.id).catch(() => {}); }
    if (workspace) await cleanupWorkspace(svc, workspace.id, ["AIOperation", "CreditLedgerEntry", "UsageEvent", "AuditLog"]);
  }
}