// Regression test for the GPT-5 Mini planning timeout fix.
//
// Reproduces the condition that caused the original failure: a model call that exceeds its
// per-attempt timeout during the planning phase. Verifies the gateway's retry-on-timeout:
//   1. A first attempt that times out is retried; the second attempt's result is returned.
//   2. Usage is recorded only for the successful attempt (no double charge).
//   3. A non-timeout error does NOT retry (propagates immediately).
//   4. When all attempts time out, the final timeout error propagates with the attempt count.
//   5. The real gateway + GPT-5 Mini can complete a planning-shaped structured-output request
//      through the normal pipeline path.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createGateway, MODEL_REGISTRY } from "../../shared/modelGateway.ts";
import { PLAN_SCHEMA } from "../../shared/prompts.ts";
import { PLANNING_CALL } from "../../shared/runPipeline.ts";
import { resetProviderHealth } from "../../shared/providerHealth.ts";

export const config = { method: "POST" };

// A mock base44 whose InvokeLLM is scriptable per call. Each entry in `behaviors` is consumed
// in order: a number means "sleep this many ms then resolve", an Error means "throw immediately".
function mockBase44(behaviors) {
  let call = 0;
  const calls = [];
  return {
    _calls: calls,
    asServiceRole: {
      integrations: {
        Core: {
          InvokeLLM: async (params) => {
            const idx = call++;
            calls.push({ idx, model: params.model, promptLength: (params.prompt || "").length });
            const behavior = behaviors[Math.min(idx, behaviors.length - 1)];
            if (behavior instanceof Error) throw behavior;
            if (typeof behavior === "number") { await new Promise((r) => setTimeout(r, behavior)); }
            return { output: { plan: [`call-${idx}`], files: [], entities: [], secrets: [], integrations: [], read_actions: [], request_more_context: false, message: `from call ${idx}` }, usage: { input_tokens: 100 + idx, output_tokens: 50 + idx } };
          },
        },
      },
    },
  };
}

const TEST_MODEL = { name: "test-model", provider: "base44-core", model_id: "test", upstream_provider: "test", pricing_version: "v1" };

export default async function (req) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });

  // 1) First attempt times out, second succeeds — retry returns the second result.
  {
    const mb = mockBase44([7000, 0]); // 12s / 2 attempts = 6s per attempt (gateway floor is 5s): call 0 sleeps 7s → times out, call 1 instant
    const gateway = createGateway(mb);
    const res = await gateway.generate(TEST_MODEL, { system: "s", messages: [{ role: "user", content: "c" }], jsonSchema: { type: "object" }, timeoutMs: 12000, maxAttempts: 2 });
    check("retry on timeout: returns second attempt result", res.output?.plan?.[0] === "call-1", res.output?.plan?.[0]);
    check("retry on timeout: exactly 2 InvokeLLM calls", mb._calls.length === 2, `${mb._calls.length} calls`);
  }

  // 2) Usage is recorded only for the successful attempt — the timed-out call's usage is discarded.
  {
    const mb = mockBase44([7000, 0]);
    const gateway = createGateway(mb);
    const res = await gateway.generate(TEST_MODEL, { system: "s", messages: [{ role: "user", content: "c" }], jsonSchema: null, timeoutMs: 12000, maxAttempts: 2 });
    // The second call (idx=1) reports input_tokens=101, output_tokens=51.
    check("no double charge: usage from successful attempt only", res.inputTokens === 101 && res.outputTokens === 51, `input=${res.inputTokens} output=${res.outputTokens}`);
  }

  // 3) Non-timeout error does NOT retry — propagates immediately.
  {
    const mb = mockBase44([new Error("model internal error")]);
    const gateway = createGateway(mb);
    let threw = null;
    try { await gateway.generate(TEST_MODEL, { system: "s", messages: [{ role: "user", content: "c" }], jsonSchema: null, timeoutMs: 10000, maxAttempts: 2 }); }
    catch (e) { threw = e; }
    check("non-timeout error: no retry", threw?.message === "model internal error" && mb._calls.length === 1, `${threw?.message} · ${mb._calls.length} calls`);
  }

  // 4) All attempts time out — final timeout error propagates with attempt count.
  {
    const mb = mockBase44([10000, 10000]); // both calls exceed the per-attempt timeout
    const gateway = createGateway(mb);
    let threw = null;
    try { await gateway.generate(TEST_MODEL, { system: "s", messages: [{ role: "user", content: "c" }], jsonSchema: null, timeoutMs: 12000, maxAttempts: 2 }); }
    catch (e) { threw = e; }
    check("total timeout: error mentions attempt 2/2", threw?.message?.includes("attempt 2/2"), threw?.message);
    check("total timeout: exactly 2 calls", mb._calls.length === 2, `${mb._calls.length} calls`);
  }

  // 5) maxAttempts=1 (default) preserves the original single-attempt behaviour — no retry.
  {
    const mb = mockBase44([10000]); // slow, would time out
    const gateway = createGateway(mb);
    let threw = null;
    try { await gateway.generate(TEST_MODEL, { system: "s", messages: [{ role: "user", content: "c" }], jsonSchema: null, timeoutMs: 2000 }); }
    catch (e) { threw = e; }
    check("default maxAttempts=1: single attempt, no retry", threw?.message?.includes("timed out") && threw?.message?.includes("attempt 1/1") && mb._calls.length === 1, `${threw?.message} · ${mb._calls.length} calls`);
  }

  // 5b) Planning budget: each attempt must cover the slow tier's expected latency (45s).
  {
    const chainLen = 2; // primary + first fallback, as in the failed runs
    const perAttempt = Math.floor(PLANNING_CALL.timeoutMs / (PLANNING_CALL.maxAttempts * chainLen));
    const slow = MODEL_REGISTRY.filter((m) => ["claude-opus-5-5", "gpt-6-astra"].includes(m.model_id));
    const maxExpected = Math.max(45000, ...slow.map((m) => m.routing?.expected_latency_ms || m.expected_latency_ms || 0));
    check("planning: per-attempt >= slow-tier expected latency", perAttempt >= maxExpected, `${perAttempt}ms vs ${maxExpected}ms`);
    check("planning: total budget bounded at 90s", PLANNING_CALL.timeoutMs <= 90000, `${PLANNING_CALL.timeoutMs}`);
  }

  // 5c) Primary times out → first fallback serves, in router order, within the budget.
  {
    // Mocked gateway provider via the existing providerOverrides hook — no real model connection.
    resetProviderHealth();
    const primary = MODEL_REGISTRY.find((m) => m.model_id === "claude-opus-5-5");
    const calls = [];
    const delays = [7000, 0];
    const mockProvider = { generate: async ({ model }) => {
      const idx = calls.length; calls.push(model.model_id);
      await new Promise((r) => setTimeout(r, delays[idx] ?? 0));
      return { output: { plan: [`call-${idx}`] }, usage: { input_tokens: 1, output_tokens: 1, usage_source: "provider" }, rawUsage: null, inputTokens: 1, outputTokens: 1, tokensEstimated: false };
    } };
    const gateway = createGateway(mockBase44([0]), { providerOverrides: { [primary?.provider]: mockProvider } });
    const totalMs = 12000; // scaled-down PLANNING_CALL: same maxAttempts, same per-chain split
    const started = Date.now();
    try {
      const res = await gateway.generate(primary, { system: "s", messages: [{ role: "user", content: "c" }], jsonSchema: null, timeoutMs: totalMs, maxAttempts: PLANNING_CALL.maxAttempts, fallbacks: ["gpt-6-astra", "claude-fable-5-1"] });
      const elapsed = Date.now() - started;
      check("fallback: first fallback served after primary timeout", calls.length === 2 && res.output?.plan?.[0] === "call-1", `${calls.length} calls · ${calls.join(" → ")}`);
      check("fallback: order preserved (claude-opus-5-5 → gpt-6-astra)", calls[0] === "claude-opus-5-5" && calls[1] === "gpt-6-astra", calls.join(" → "));
      check("fallback: total budget bounded", elapsed <= totalMs, `${elapsed}ms <= ${totalMs}ms`);
    } catch (e) {
      check("fallback: first fallback served after primary timeout", false, `${e.message} · ${calls.join(" → ")}`);
    }
    resetProviderHealth();
  }

  // 6) Real GPT-5 Mini planning request through the normal gateway — verifies the model can
  //    complete a structured-output planning call (the exact scenario that was timing out).
  {
    const client = createClientFromRequest(req);
    const gpt5 = MODEL_REGISTRY.find((m) => m.model_id === "gpt-5-mini");
    if (!gpt5) {
      check("real GPT-5 Mini planning: model in registry", false, "gpt-5-mini not found");
    } else {
      const gateway = createGateway(client);
      const system = "You are an application builder planner. Return a JSON plan matching the schema.";
      const messages = [{ role: "user", content: "Build a simple counter app with an increment button. The plan should include one page file and no entities." }];
      try {
        const res = await gateway.generate(gpt5, { system, messages, jsonSchema: PLAN_SCHEMA, timeoutMs: 90000, maxAttempts: 2 });
        const plan = res.output || {};
        check("real GPT-5 Mini planning: returns structured plan", Array.isArray(plan.files) && plan.files.length > 0, `files: ${plan.files?.length}`);
        check("real GPT-5 Mini planning: plan has a message", typeof plan.message === "string", plan.message?.slice(0, 80));
        check("real GPT-5 Mini planning: usage recorded", res.inputTokens > 0 && res.outputTokens > 0, `in=${res.inputTokens} out=${res.outputTokens}`);
      } catch (e) {
        check("real GPT-5 Mini planning: completes within 90s (2×45s)", false, e.message);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}