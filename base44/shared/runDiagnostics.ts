// Durable, structured failure diagnostics for Builder runs. Diagnostics only: nothing here
// changes what the pipeline generates, writes or retries.
const MAX_MESSAGE = 500;

export function failureRecord(stage, path, operation, error) {
  const message = String(error?.message ?? error ?? "unknown error").slice(0, MAX_MESSAGE);
  return { stage, path: path || null, operation: operation || null, code: error?.code || null, message, at: new Date().toISOString() };
}

// One-line summary per failure, for step details and build logs.
export function describeFailure(f) {
  return `[${f.stage}] ${f.operation || "op"} ${f.path || "-"}: ${f.message}`;
}

export function failureDetail(records, limit = 5) {
  if (!records?.length) return "";
  const shown = records.slice(0, limit).map(describeFailure).join(" | ");
  return records.length > limit ? `${shown} | +${records.length - limit} more` : shown;
}

// Planned content paths (create/rewrite/patch) that never landed as a file change.
export function unappliedPlannedPaths(manifest = [], changes = []) {
  const changed = new Set(changes.filter((c) => c.change !== "deleted").map((c) => c.path));
  return manifest.filter((f) => f.action !== "move" && f.action !== "delete" && !changed.has(f.path)).map((f) => f.path);
}

// Build-log lines that keep generation and repair failures distinguishable in the Build record.
export function diagnosticLogLines({ generation = [], repair = [] } = {}) {
  return [
    ...generation.map((f) => `diag generation: ${describeFailure(f)}`),
    ...repair.map((f) => `diag repair: ${describeFailure(f)}`),
  ];
}