// Regression test for the Claude "compiled grammar is too large" planning failure.
//
// Root cause: PLAN_SCHEMA had ~180+ properties across deeply nested objects (DESIGN_SCHEMA
// alone had ~100 explicit token properties). Claude's strict structured output compiles the
// JSON schema into a grammar, and the compiled grammar exceeded Claude's size limit.
//
// Fix: compacted DESIGN_SCHEMA to a flat {group, key, value} array (~4 properties instead of
// ~100), and made conditional fields optional in the integration/read_actions/file schemas.
//
// This test verifies:
//   1. The compacted PLAN_SCHEMA has far fewer properties (grammar-size proxy).
//   2. designPatchToObject converts the compact array format to the object format mergeTokens
//      expects, and passes through the legacy object format.
//   3. A real Claude Sonnet 5 planning request succeeds through the normal Gateway path with
//      the compacted schema (the exact scenario that was failing).
//   4. A real GPT-5 Mini planning request still succeeds (backward compatibility).
//   5. A real Gemini 3 Flash planning request still succeeds (backward compatibility).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createGateway, MODEL_REGISTRY } from "../../shared/modelGateway.ts";
import { PLAN_SCHEMA } from "../../shared/prompts.ts";
import { DESIGN_SCHEMA, designPatchToObject, mergeTokens, DEFAULT_TOKENS } from "../../shared/designSystem.ts";

export const config = { method: "POST" };

// Recursively counts all property definitions in a JSON schema — a proxy for compiled
// grammar size. Claude's limit is on the compiled grammar, which is roughly proportional
// to the total number of properties and their types.
function countProperties(schema) {
  if (!schema || typeof schema !== "object") return 0;
  let count = 0;
  const props = schema.properties;
  if (props) {
    for (const key of Object.keys(props)) {
      count++;
      count += countProperties(props[key]);
    }
  }
  if (schema.items) count += countProperties(schema.items);
  return count;
}

export default async function (req) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });

  // 1) The compacted PLAN_SCHEMA has far fewer properties than the ~180+ the original had.
  {
    const planProps = countProperties(PLAN_SCHEMA);
    const designProps = countProperties(DESIGN_SCHEMA);
    check("PLAN_SCHEMA property count reduced", planProps < 80, `${planProps} properties (was ~180+)`);
    check("DESIGN_SCHEMA property count reduced", designProps < 10, `${designProps} properties (was ~100)`);
  }

  // 2) designPatchToObject converts the compact array format to the object format.
  {
    const compact = { rationale: "dark premium", tokens: [
      { group: "colors", key: "primary", value: "#818cf8" },
      { group: "colors", key: "background", value: "#0b1120" },
      { group: "typography", key: "size_base", value: "1rem" },
    ]};
    const obj = designPatchToObject(compact);
    check("designPatchToObject: converts array to object", obj.colors?.primary === "#818cf8" && obj.colors?.background === "#0b1120" && obj.typography?.size_base === "1rem", JSON.stringify(obj));
    check("designPatchToObject: preserves rationale", obj.rationale === "dark premium", obj.rationale);
  }

  // 2b) designPatchToObject passes through the legacy object format (backward compat).
  {
    const legacy = { rationale: "test", colors: { primary: "#ff0000" } };
    const obj = designPatchToObject(legacy);
    check("designPatchToObject: legacy object format passthrough", obj.colors?.primary === "#ff0000", JSON.stringify(obj));
  }

  // 2c) designPatchToObject handles null/empty.
  {
    check("designPatchToObject: null → {}", Object.keys(designPatchToObject(null)).length === 0, "null");
    check("designPatchToObject: empty → {}", Object.keys(designPatchToObject({})).length === 0, "empty");
  }

  // 2d) mergeTokens works with the converted compact patch.
  {
    const compact = { rationale: "test", tokens: [{ group: "colors", key: "primary", value: "#818cf8" }] };
    const obj = designPatchToObject(compact);
    const merged = mergeTokens(DEFAULT_TOKENS, obj);
    check("mergeTokens: applies converted compact patch", merged.tokens.colors.primary === "#818cf8" && merged.applied.includes("colors.primary"), merged.applied.join(","));
  }

  // 3) Real Claude Sonnet 5 planning request succeeds with the compacted schema.
  {
    const client = createClientFromRequest(req);
    const claude = MODEL_REGISTRY.find((m) => m.model_id === "claude-sonnet-5");
    if (!claude) {
      check("real Claude planning: model in registry", false, "claude-sonnet-5 not found");
    } else {
      const gateway = createGateway(client);
      const system = "You are the planning engine of an AI application builder. Return a JSON plan matching the schema exactly.";
      const messages = [{ role: "user", content: "Build a simple counter app with an increment button and a dark premium design. One page file, no entities, no integrations." }];
      try {
        const res = await gateway.generate(claude, { system, messages, jsonSchema: PLAN_SCHEMA, timeoutMs: 90000, maxAttempts: 2 });
        const plan = res.output || {};
        check("real Claude planning: returns structured plan", Array.isArray(plan.files) && plan.files.length > 0, `files: ${plan.files?.length}`);
        check("real Claude planning: has message", typeof plan.message === "string", plan.message?.slice(0, 80));
        check("real Claude planning: usage recorded", res.inputTokens > 0 && res.outputTokens > 0, `in=${res.inputTokens} out=${res.outputTokens}`);
      } catch (e) {
        check("real Claude planning: completes without grammar error", false, e.message);
      }
    }
  }

  // 4) Real GPT-5 Mini planning request still succeeds (backward compatibility).
  {
    const client = createClientFromRequest(req);
    const gpt5 = MODEL_REGISTRY.find((m) => m.model_id === "gpt-5-mini");
    if (!gpt5) {
      check("real GPT-5 Mini planning: model in registry", false, "gpt-5-mini not found");
    } else {
      const gateway = createGateway(client);
      const system = "You are the planning engine of an AI application builder. Return a JSON plan matching the schema exactly.";
      const messages = [{ role: "user", content: "Build a simple counter app with an increment button. One page file, no entities." }];
      try {
        const res = await gateway.generate(gpt5, { system, messages, jsonSchema: PLAN_SCHEMA, timeoutMs: 90000, maxAttempts: 2 });
        const plan = res.output || {};
        check("real GPT-5 Mini planning: returns structured plan", Array.isArray(plan.files) && plan.files.length > 0, `files: ${plan.files?.length}`);
        check("real GPT-5 Mini planning: has message", typeof plan.message === "string", plan.message?.slice(0, 80));
      } catch (e) {
        check("real GPT-5 Mini planning: succeeds", false, e.message);
      }
    }
  }

  // 5) Real Gemini 3 Flash planning request still succeeds (backward compatibility).
  {
    const client = createClientFromRequest(req);
    const gemini = MODEL_REGISTRY.find((m) => m.model_id === "gemini-3-flash");
    if (!gemini) {
      check("real Gemini planning: model in registry", false, "gemini-3-flash not found");
    } else {
      const gateway = createGateway(client);
      const system = "You are the planning engine of an AI application builder. Return a JSON plan matching the schema exactly.";
      const messages = [{ role: "user", content: "Build a simple counter app with an increment button. One page file, no entities." }];
      try {
        const res = await gateway.generate(gemini, { system, messages, jsonSchema: PLAN_SCHEMA, timeoutMs: 90000, maxAttempts: 2 });
        const plan = res.output || {};
        check("real Gemini planning: returns structured plan", Array.isArray(plan.files) && plan.files.length > 0, `files: ${plan.files?.length}`);
      } catch (e) {
        check("real Gemini planning: succeeds", false, e.message);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}