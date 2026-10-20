// Phase 16B — Workspace Skills presets + Refine & review.
//
// DOCUMENTED (Base44): skills can be created from scratch or started from built-in presets
// (Workspace Settings → Plugins → Skills → Add skill → "Preset skill" → Add), after which the
// normal editor (name, description, instructions) applies and the skill is added through the
// normal creation path. DOCUMENTED (Base44): "Refine & review" has the AI refine and adjust the
// skill's description and instructions "while keeping your intent"; the review window offers
// Back to original, Save skill and Cancel.
//
// NOT PUBLISHED (Base44): the exact preset catalog (names and contents), preset storage
// semantics, and any model/credit policy for refinement. The presets below are therefore
// NEXUSAI-DERIVED content aligned with the documented skill categories (design, copy, data);
// they are never presented as Base44-identical. Refinement runs on the platform's default LLM
// integration path with NO custom model selection and NO custom credit semantics, and writes
// NOTHING to the database — persistence stays with the existing WorkspaceSkill CRUD.
import { validatedSkillFields } from "./skills.ts";

export const WORKSPACE_SKILL_PRESETS = [
  {
    name: "design-principles",
    description: "Applies when the AI builds or adjusts the UI — layout, spacing and hierarchy decisions.",
    instructions: "1. Keep layouts simple and scannable: one primary action per view.\n2. Use consistent spacing and align elements to a grid.\n3. Preserve a clear visual hierarchy: headings, then body text, then controls.\n4. Prefer reusing existing components and patterns over inventing new ones.\n5. Check that text remains readable at smaller sizes.",
  },
  {
    name: "copy-style",
    description: "Applies when the AI writes product text — headlines, landing pages and in-app copy.",
    instructions: "1. Lead with the benefit; keep headlines short.\n2. Use plain, direct language; avoid jargon and filler.\n3. Keep buttons short and verb-first (e.g. \"Save changes\").\n4. Match the tone to the audience without exaggerating claims.\n5. Keep terminology consistent across every page.",
  },
  {
    name: "data-analysis",
    description: "Applies when the AI works with metrics and structured data in the app.",
    instructions: "1. State what a metric measures before interpreting it.\n2. Prefer counts, percentages and trends over vague qualifiers.\n3. Flag missing or suspicious data instead of guessing.\n4. Summarize findings first, then show the supporting numbers.\n5. Recommend a next step for every analysis.",
  },
];

// A preset must satisfy the SAME validation every created skill passes through, so a preset
// can never prefill a field the CRUD would refuse. Names are unique.
export function validPresetCatalog() {
  const seen = new Set();
  return WORKSPACE_SKILL_PRESETS.every((p) => {
    try { validatedSkillFields(p); } catch { return false; }
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

const REFINE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    instructions: { type: "string" },
  },
  required: ["description", "instructions"],
  additionalProperties: false,
};

// Refinement PROPOSAL only: never persists, never returns or touches a name. Fail closed —
// an unusable model response raises instead of silently returning the originals.
export async function refineWorkspaceSkill(svc, { description, instructions }) {
  // Only description + instructions are required here — a name is never part of a refine input.
  const original = validatedSkillFields({ description, instructions }, true);
  if (!original.description || !original.instructions) {
    throw Object.assign(new Error("description and instructions are required"), { status: 400, code: "SKILL_INVALID" });
  }
  const prompt = [
    "Refine a saved instruction set (a \"workspace skill\") that guides how an AI assistant builds apps in a workspace.",
    "Preserve the author's intent exactly: same purpose, same audience, same rules. Do not add requirements the author did not state, and do not remove any stated rule.",
    "Improve clarity, structure and specificity only. Keep every heading, example and priority the author gave unless rewording makes it clearer.",
    "Write the refined text in the same language as the original.",
    "Return only the refined DESCRIPTION (when the skill applies) and INSTRUCTIONS (the step-by-step rules).",
    "",
    `ORIGINAL DESCRIPTION:\n${original.description}`,
    "",
    `ORIGINAL INSTRUCTIONS:\n${original.instructions}`,
  ].join("\n");
  const raw = await svc.integrations.Core.InvokeLLM({ prompt, response_json_schema: REFINE_SCHEMA });
  // Only the wrapped model-response shape { output } carries content apart from a plain
  // structured result; unwrap exactly like the model gateway does.
  const out = !!raw && typeof raw === "object" && !Array.isArray(raw)
    && Object.prototype.hasOwnProperty.call(raw, "output") ? raw.output : raw;
  if (!out || typeof out !== "object") {
    throw Object.assign(new Error("The refinement could not be completed"), { status: 502, code: "REFINE_FAILED" });
  }
  // Only description + instructions are validated and returned — a name is never part of the
  // refinement output, so it is untouched by construction.
  const refined = validatedSkillFields({ description: out.description, instructions: out.instructions }, true);
  if (!refined.description || !refined.instructions) {
    throw Object.assign(new Error("The refinement could not be completed"), { status: 502, code: "REFINE_FAILED" });
  }
  return { description: refined.description, instructions: refined.instructions };
}