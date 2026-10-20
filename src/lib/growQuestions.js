// Grow inline questionnaire contract: the Growth Agent may end a clarification reply with ONE
// fenced block  ```grow-questions {"questions":[{id,label,type:"single"|"multi"|"text",options?}]}```
// The block is stripped from the rendered message and shown as controls above the composer.
// Tolerates the tag on the fence line or on the first line inside the fence (observed live).
const BLOCK = /```[ \t]*\n?[ \t]*grow-questions[ \t]*\n([\s\S]*?)```/;
const TYPES = ["single", "multi", "text"];

export function stripQuestions(content) {
  return typeof content === "string" ? content.replace(BLOCK, "").trim() : content;
}

export function parseQuestions(content) {
  const m = typeof content === "string" && content.match(BLOCK);
  if (!m) return null;
  try {
    const qs = (JSON.parse(m[1]).questions || [])
      .filter((q) => q && q.id && q.label && TYPES.includes(q.type))
      .map((q) => ({ ...q, options: Array.isArray(q.options) ? q.options.map(String).slice(0, 8) : [] }))
      .filter((q) => q.type === "text" || q.options.length)
      .slice(0, 4);
    return qs.length ? qs : null;
  } catch {
    return null;
  }
}

export function formatAnswers(questions, answers) {
  const lines = questions.map((q) => {
    const v = answers[q.id];
    const val = Array.isArray(v) ? v.join(", ") : (v || "").trim();
    return `- ${q.label}: ${val || "(skipped)"}`;
  });
  return `My answers:\n${lines.join("\n")}`;
}