// THE Base44-compatible workflow RESOURCE contract — pure, dependency-light, no database and no
// execution.
//
// NexusAI already owns a complete workflow implementation: the definition/version model
// (WorkflowDefinition), the deterministic contract and validator (workflowContract.ts), the durable
// executor (workflowEngine.ts) and the authorized surface (workflowApi.ts). What it did NOT have is
// the Base44 shape of the SAME workflow: a declarative project resource file that lives in the
// project's own filesystem, is versioned with the project, and is loaded/validated like any other
// resource.
//
// This module is that contract and nothing more:
//   • which paths are workflow resources (base44/workflows/<Name>.jsonc)
//   • how one document is parsed into the EXISTING definition shape, and emitted back from it
//   • document-level validation, delegated to the EXISTING validateWorkflow
//
// It creates no second engine, no second validator and no second trigger system. Everything a
// document declares is the same configuration the existing DB definition already carries, so a
// file-authored workflow and an API-authored workflow execute through exactly the same engine.
// Deliberately DB-free so the filesystem and the build can import it without pulling in the
// authorized API (and without an import cycle); the database side lives in workflowSync.ts.
import { parseJsonc } from "./base44Layout.ts";
import { validateWorkflow, workflowChecksum, WORKFLOW_CONTRACT_VERSION, STEP_DEFAULTS, WORKFLOW_LIMITS } from "./workflowContract.ts";

export const WORKFLOWS_DIR = "base44/workflows/";
export const WORKFLOW_FILE_RE = /^base44\/workflows\/[A-Za-z][A-Za-z0-9 _-]*\.jsonc$/;

export const isWorkflowFilePath = (path) => WORKFLOW_FILE_RE.test(String(path || ""));
/** The workflow NAME a resource path declares — the file name is the workflow's identity. */
export const workflowNameFromPath = (path) => String(path || "").slice(WORKFLOWS_DIR.length).replace(/\.jsonc$/, "");
export const workflowFilePath = (name) => `${WORKFLOWS_DIR}${name}.jsonc`;

/**
 * The stable lineage key a resource file maps to. Derived from the FILE NAME, so renaming a
 * workflow's display text inside the document never silently forks its lineage, and two files can
 * never claim the same lineage.
 */
export const workflowKeyFromPath = (path) => String(workflowNameFromPath(path)).trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, WORKFLOW_LIMITS.name_chars) || "workflow";

/**
 * Fingerprint of ONE workflow's CONFIGURATION, comparable across a resource FILE and a STORED
 * definition — used ONLY by the resource layer.
 *
 * A stored definition comes back from the database with every optional step field materialized as
 * `null`, while a resource document states only the fields it actually uses. Comparing the raw
 * shapes would therefore report "changed" on every sync of an unchanged file and append a version
 * each time. So the comparison is made over the definition with absent/null fields removed, using
 * the SAME deterministic `workflowChecksum` — no second hashing scheme, and nothing here changes the
 * `definition_checksum` the existing engine and finalization logic compute and store.
 */
export function resourceChecksum(definition) {
  const d = definition || {};
  const prune = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined));
  return workflowChecksum({
    name: d.name, trigger: prune(d.trigger), steps: (Array.isArray(d.steps) ? d.steps : []).map(prune),
    entry_step: d.entry_step || null, on_failure: d.on_failure || null,
    timeout_ms: d.timeout_ms == null ? null : Number(d.timeout_ms),
    step_defaults: d.step_defaults || STEP_DEFAULTS,
  });
}

/** Top-level keys a workflow document may declare. Anything else is a stated refusal. */
const DOCUMENT_KEYS = ["name", "description", "trigger", "steps", "entry_step", "on_failure", "timeout_ms", "step_defaults", "contract_version"];

/**
 * Parses ONE workflow resource document into the definition shape the existing API and engine
 * already use. Returns `{ ok, definition }` or `{ ok: false, error }` — a malformed document is
 * always a stated failure, never a silently defaulted workflow.
 */
export function parseWorkflowDocument(path, text) {
  let doc;
  try { doc = parseJsonc(text); } catch (e) { return { ok: false, error: `is not valid JSONC: ${e.message}` }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "must be a JSON object" };
  const unknown = Object.keys(doc).filter((k) => !DOCUMENT_KEYS.includes(k));
  if (unknown.length) return { ok: false, error: `declares unrecognised key(s): ${unknown.join(", ")}` };
  if (doc.name != null && typeof doc.name !== "string") return { ok: false, error: "'name' must be a string" };
  if (doc.steps != null && !Array.isArray(doc.steps)) return { ok: false, error: "'steps' must be an array of steps" };
  if (doc.trigger != null && (typeof doc.trigger !== "object" || Array.isArray(doc.trigger))) return { ok: false, error: "'trigger' must be an object" };
  if (doc.contract_version != null && String(doc.contract_version) !== WORKFLOW_CONTRACT_VERSION) {
    return { ok: false, error: `was authored against contract '${doc.contract_version}'; this platform speaks '${WORKFLOW_CONTRACT_VERSION}'` };
  }

  // The document is a PROJECTION of the existing definition shape — same fields, same meaning.
  const definition = {
    name: String(doc.name || workflowNameFromPath(path)),
    description: doc.description == null ? null : String(doc.description),
    trigger: doc.trigger || { type: "manual" },
    steps: doc.steps || [],
    entry_step: doc.entry_step == null ? null : String(doc.entry_step),
    on_failure: doc.on_failure == null ? null : String(doc.on_failure),
    timeout_ms: doc.timeout_ms == null ? null : Number(doc.timeout_ms),
    step_defaults: { ...STEP_DEFAULTS, ...(doc.step_defaults && typeof doc.step_defaults === "object" ? doc.step_defaults : {}) },
  };
  return {
    ok: true,
    path: String(path),
    workflow_key: workflowKeyFromPath(path),
    definition,
    // Normalized fingerprint, so a document and an already-stored version of the same workflow
    // compare equal and an unchanged file never appends a version.
    definition_checksum: resourceChecksum(definition),
  };
}

/**
 * Emits a definition back to its resource document. Deterministic key order, so re-emitting an
 * unchanged workflow produces a byte-identical file and therefore no spurious project change.
 */
export function workflowDocumentContent(definition) {
  const d = definition || {};
  const doc = {
    name: String(d.name || "workflow"),
    ...(d.description ? { description: String(d.description) } : {}),
    contract_version: WORKFLOW_CONTRACT_VERSION,
    trigger: d.trigger || { type: "manual" },
    entry_step: d.entry_step || null,
    ...(d.on_failure ? { on_failure: String(d.on_failure) } : {}),
    ...(d.timeout_ms == null ? {} : { timeout_ms: Number(d.timeout_ms) }),
    ...(d.step_defaults ? { step_defaults: d.step_defaults } : {}),
    steps: Array.isArray(d.steps) ? d.steps : [],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Every workflow resource file in a file set, in deterministic path order. */
export const collectWorkflowFiles = (files) => (files || [])
  .filter((f) => isWorkflowFilePath(f.path))
  .sort((a, b) => a.path.localeCompare(b.path));

/**
 * Validates every workflow resource document in a file set: the document shape HERE, and the
 * workflow itself through the EXISTING validator (which owns step references, primitives,
 * functions, triggers, reachability and acyclicity). No second set of rules exists.
 *
 * `functionNames` is passed straight through, so a function step is verified against the project's
 * real functions when the caller knows them and reported as unverified when it does not.
 */
export function validateWorkflowFiles(files, { functionNames = null } = {}) {
  const results = [];
  const seenKeys = new Map();
  for (const f of collectWorkflowFiles(files)) {
    const parsed = parseWorkflowDocument(f.path, f.content);
    if (!parsed.ok) { results.push({ path: f.path, ok: false, errors: [`${f.path} ${parsed.error}`] }); continue; }
    // Two files resolving to one lineage would make "which version is this?" ambiguous.
    if (seenKeys.has(parsed.workflow_key)) {
      results.push({ path: f.path, ok: false, workflow_key: parsed.workflow_key, errors: [`${f.path} resolves to the same workflow as ${seenKeys.get(parsed.workflow_key)}`] });
      continue;
    }
    seenKeys.set(parsed.workflow_key, f.path);
    const report = validateWorkflow(parsed.definition, { functionNames });
    results.push({
      path: f.path, ok: report.ok, workflow_key: parsed.workflow_key, name: parsed.definition.name,
      definition_checksum: parsed.definition_checksum, checks: report.checks,
      errors: report.ok ? [] : report.errors.map((e) => `${f.path} ${e}`),
      report,
    });
  }
  return { ok: results.every((r) => r.ok), count: results.length, workflows: results, errors: results.flatMap((r) => r.errors) };
}