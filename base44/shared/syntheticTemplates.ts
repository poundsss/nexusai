// NexusAI Synthetic Task Generator — TEMPLATES and DETERMINISTIC GENERATION.
//
// Produces benchmark-ready app-building tasks whose success is MACHINE-CHECKABLE. This module is
// pure: it reads no database, writes nothing, calls no model and touches no clock or randomness
// source other than the caller's seed. Same template + version + seed + parameters ⇒ byte-identical
// task, which is what makes every generated variation reproducible.
//
// Boundaries this module keeps:
//   NO EXECUTION — nothing here runs a task against a model. Execution belongs to #23.
//   SYNTHETIC ONLY — every name, field, file and data row comes from fixed synthetic pools. No user
//     or project data can enter a generated task, because none is read.
//   EXPLICIT COMPLEXITY — difficulty maps to a recorded knob set; complexity is never raised
//     without appearing in the task's own complexity block.
//   ONE BENCHMARK CONTRACT — the fixture is emitted in the shape #23 already consumes
//     ({ files, entities }), so no second benchmark task schema exists.
import { fingerprint } from "./benchmark.ts";

export const GENERATOR_VERSION = "1.0.0";
export const FIXTURE_VERSION = "1.0.0";

export const TASK_CATEGORIES = [
  "crud_data_modeling", "ui_feature", "auth_rbac", "api_integration", "schema_migration",
  "debugging_repair", "multi_step_workflow", "data_query", "architecture",
];
export const DIFFICULTIES = ["easy", "medium", "hard", "expert"];
export const CHECK_TYPES = [
  "file_exists", "entity_schema", "route_exists", "function_exists", "api_behavior",
  "build_succeeds", "runtime_behavior", "data_invariant", "authorization_behavior", "workflow_transition",
];
export const INVARIANT_TYPES = [
  "no_duplicate_records", "relation_exists", "role_required", "valid_state_transition",
  "migration_preserves_fields", "endpoint_shape",
];
export const OUTCOME_TYPES = [
  "feature_implemented", "schema_migrated", "bug_repaired", "workflow_implemented",
  "integration_implemented", "authorization_enforced", "query_implemented", "architecture_refactored",
];

/**
 * Difficulty knobs. The ONLY place complexity is decided, so a harder task differs from an easier
 * one in stated, countable ways rather than in vague prose.
 */
export const DIFFICULTY_KNOBS = {
  easy: { entities: 1, components: 1, operations: 2, dependency_depth: 1, constraints: 1, validation_criteria: 4, seed_rows: 3, max_steps: 4, time_budget_ms: 60000 },
  medium: { entities: 2, components: 2, operations: 3, dependency_depth: 2, constraints: 2, validation_criteria: 6, seed_rows: 6, max_steps: 6, time_budget_ms: 90000 },
  hard: { entities: 3, components: 3, operations: 4, dependency_depth: 3, constraints: 3, validation_criteria: 8, seed_rows: 12, max_steps: 10, time_budget_ms: 150000 },
  expert: { entities: 4, components: 4, operations: 5, dependency_depth: 4, constraints: 4, validation_criteria: 10, seed_rows: 20, max_steps: 14, time_budget_ms: 210000 },
};

export const GEN_LIMITS = { entities: 6, components: 6, checks: 40, invariants: 12, goal: 4000 };

// --- deterministic randomness --------------------------------------------------

/** Seeded PRNG (FNV-1a seeding + mulberry32). Deterministic and dependency-free. */
export function seededRng(seedText) {
  let h = 2166136261;
  const text = String(seedText ?? "");
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic vocabulary. Fixed pools, so nothing generated can resemble real project data.
const NOUNS = ["invoice", "ticket", "shipment", "recipe", "lesson", "booking", "asset", "incident", "survey", "playlist", "permit", "sample"];
const FIELDS = ["title", "label", "amount", "quantity", "status", "notes", "priority", "code", "due_on", "score"];
const ROLES = ["admin", "manager", "member", "auditor"];
const STATES = ["draft", "submitted", "approved", "closed", "archived"];
const FEATURES = ["search", "filter", "sort", "pagination", "bulk_select", "inline_edit"];
const OPERATIONS = ["create", "read", "update", "delete", "list", "filter", "aggregate"];

const pickN = (rng, pool, n) => {
  const copy = [...pool];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
};
const pascal = (s) => String(s).replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());

const FIELD_TYPES = { amount: "number", quantity: "number", score: "number", due_on: "string", default: "string" };
const fieldType = (name) => FIELD_TYPES[name] || FIELD_TYPES.default;

// --- fixture ------------------------------------------------------------------

const FIXTURE_HEADER = "// SYNTHETIC BENCHMARK FIXTURE — generated content, no real project data.";

/**
 * The synthetic starting project every generated task hands to a model. Emitted in the shape #23's
 * BenchmarkTask.initial_state already consumes; seed data, configuration and test inputs are
 * materialized as fixture FILES so a single fixture format serves both layers.
 */
function buildFixture({ seedEntities, seedRows, configuration, testInputs, extraFiles = [] }) {
  const files = [
    { path: "index.html", content: `<!doctype html><html><head><title>Synthetic Fixture</title></head><body><div id="root"></div></body></html>` },
    { path: "src/app.js", content: `${FIXTURE_HEADER}\nexport default function App() {\n  return 'synthetic fixture';\n}\n` },
    { path: "src/lib/store.js", content: `${FIXTURE_HEADER}\nexport const records = [];\nexport const upsert = (row) => { records.push(row); return row; };\n` },
    { path: "src/fixtures/seed.json", content: JSON.stringify({ fixture_version: FIXTURE_VERSION, entities: seedEntities, rows: seedRows }, null, 2) },
    { path: "src/fixtures/config.json", content: JSON.stringify({ fixture_version: FIXTURE_VERSION, configuration, test_inputs: testInputs }, null, 2) },
    ...extraFiles,
  ];
  return {
    initial_state: { files, entities: seedEntities },
    fixture: { fixture_version: FIXTURE_VERSION, synthetic: true, seed_entities: seedEntities, seed_rows: seedRows, configuration, test_inputs: testInputs, file_count: files.length },
  };
}

const seedRowsFor = (entity, count) =>
  Array.from({ length: count }, (_, i) => {
    const row = { id: `${entity.name.toLowerCase()}_${i + 1}` };
    for (const [f, def] of Object.entries(entity.fields)) row[f] = def.type === "number" ? (i + 1) * 10 : `${f}_${i + 1}`;
    return row;
  });

// --- check / invariant builders -------------------------------------------------

const mkCheck = (i, type, target, assertion, description) => ({
  check_id: `chk_${String(i + 1).padStart(2, "0")}_${type}`, type, target, assert: assertion, description,
});
const mkInvariant = (i, type, target, assertion, description) => ({
  invariant_id: `inv_${String(i + 1).padStart(2, "0")}_${type}`, type, target, assert: assertion, description,
});

// --- category generators --------------------------------------------------------

/**
 * One generator per category. Each returns the task's goal, its targets, its machine-checkable
 * checks, its invariants and its fixture. Everything is derived from the seeded RNG and the
 * difficulty knobs, so the output is a pure function of (template, seed, parameters).
 */
const GENERATORS = {
  crud_data_modeling(ctx) {
    const { rng, knobs, entities, ops } = ctx;
    const files = entities.map((e) => `src/pages/${e.name}List.js`);
    const routes = entities.map((e) => `/${e.name.toLowerCase()}s`);
    const checks = [];
    entities.forEach((e, i) => {
      checks.push(mkCheck(checks.length, "entity_schema", e.name, { entity: e.name, required_fields: Object.keys(e.fields), field_types: Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, v.type])) }, `Entity ${e.name} exists with the required fields and types.`));
      checks.push(mkCheck(checks.length, "file_exists", files[i], { path: files[i], must_reference: e.name }, `A list page for ${e.name} exists and references the entity.`));
      checks.push(mkCheck(checks.length, "route_exists", routes[i], { route: routes[i], renders_file: files[i] }, `Route ${routes[i]} renders the ${e.name} list.`));
    });
    checks.push(mkCheck(checks.length, "data_invariant", entities[0].name, { entity: entities[0].name, operations_supported: ops }, `Every required operation (${ops.join(", ")}) works on ${entities[0].name}.`));
    const invariants = [mkInvariant(0, "no_duplicate_records", entities[0].name, { entity: entities[0].name, unique_fields: ["id"] }, `No two ${entities[0].name} records may share an id.`)];
    if (entities.length > 1) invariants.push(mkInvariant(1, "relation_exists", `${entities[1].name}.${entities[0].name.toLowerCase()}_id`, { from: entities[1].name, to: entities[0].name, field: `${entities[0].name.toLowerCase()}_id` }, `${entities[1].name} must reference ${entities[0].name}.`));
    return {
      goal: `Model ${entities.length} synthetic entit${entities.length > 1 ? "ies" : "y"} (${entities.map((e) => `${e.name}: ${Object.keys(e.fields).join(", ")}`).join("; ")}) and expose ${ops.join(", ")} for each through list pages at ${routes.join(", ")}. Dependency depth ${knobs.dependency_depth}.`,
      expected_outcome_type: "feature_implemented",
      targets: { entities: entities.map((e) => e.name), files, routes, functions: [] },
      checks, invariants, capabilities: ["code"],
      fixtureSpec: { seedEntities: [], seedRows: [], configuration: { crud_operations: ops }, testInputs: { sample_titles: pickN(rng, FIELDS, 2) } },
    };
  },

  ui_feature(ctx) {
    const { rng, knobs, entities, params } = ctx;
    const features = pickN(rng, FEATURES, knobs.components);
    const components = features.map((f) => `src/components/${pascal(f)}Panel.js`);
    const route = `/${entities[0].name.toLowerCase()}-workspace`;
    const checks = components.map((path, i) => mkCheck(i, "file_exists", path, { path, must_reference: features[i] }, `Component for ${features[i]} exists.`));
    checks.push(mkCheck(checks.length, "route_exists", route, { route, renders_file: components[0] }, `Route ${route} renders the feature surface.`));
    checks.push(mkCheck(checks.length, "runtime_behavior", route, { route, expect: "renders_without_error", visible_features: features }, `The page renders every feature (${features.join(", ")}) without a runtime error.`));
    checks.push(mkCheck(checks.length, "entity_schema", entities[0].name, { entity: entities[0].name, required_fields: Object.keys(entities[0].fields) }, `The feature reads ${entities[0].name}.`));
    const seedEntities = entities.slice(0, 1);
    return {
      goal: `Implement a UI surface at ${route} for ${entities[0].name} with ${knobs.components} feature panel(s): ${features.join(", ")}. Respect ${knobs.constraints} layout constraint(s): ${params.constraints.join("; ")}.`,
      expected_outcome_type: "feature_implemented",
      targets: { entities: seedEntities.map((e) => e.name), files: components, routes: [route], functions: [] },
      checks, invariants: [mkInvariant(0, "no_duplicate_records", entities[0].name, { entity: entities[0].name, unique_fields: ["id"] }, "The list must not render duplicate records.")],
      capabilities: ["code"],
      fixtureSpec: { seedEntities, seedRows: seedRowsFor(entities[0], knobs.seed_rows), configuration: { features }, testInputs: { search_term: "label_1" } },
    };
  },

  auth_rbac(ctx) {
    const { rng, knobs, entities } = ctx;
    const roles = pickN(rng, ROLES, Math.max(2, Math.min(knobs.constraints + 1, ROLES.length)));
    const page = `src/pages/${entities[0].name}Admin.js`;
    const route = `/${entities[0].name.toLowerCase()}-admin`;
    const checks = [
      mkCheck(0, "authorization_behavior", route, { route, allowed_roles: [roles[0]], denied_roles: roles.slice(1), expect_denied_status: 403 }, `Only ${roles[0]} may reach ${route}; every other role is denied.`),
      mkCheck(1, "entity_schema", entities[0].name, { entity: entities[0].name, required_fields: [...Object.keys(entities[0].fields), "owner_id"] }, `${entities[0].name} records an owner_id for ownership checks.`),
      mkCheck(2, "file_exists", page, { path: page, must_reference: "role" }, "The admin page performs a role check."),
      mkCheck(3, "route_exists", route, { route, renders_file: page }, `Route ${route} exists.`),
      mkCheck(4, "data_invariant", entities[0].name, { entity: entities[0].name, rule: "reader_sees_only_own_records", scope_field: "owner_id" }, "A non-admin reader may only read their own records."),
    ];
    return {
      goal: `Enforce role-based access for ${entities[0].name}: roles ${roles.join(", ")}, with an admin surface at ${route}. Only ${roles[0]} may manage records; every other role is limited to its own rows via owner_id.`,
      expected_outcome_type: "authorization_enforced",
      targets: { entities: [entities[0].name], files: [page], routes: [route], functions: [] },
      checks,
      invariants: [
        mkInvariant(0, "role_required", route, { route, required_role: roles[0] }, `${route} requires the ${roles[0]} role.`),
        mkInvariant(1, "no_duplicate_records", entities[0].name, { entity: entities[0].name, unique_fields: ["id"] }, "No duplicate records."),
      ],
      capabilities: ["code"],
      fixtureSpec: { seedEntities: [{ ...entities[0], fields: { ...entities[0].fields, owner_id: { type: "string" } } }], seedRows: seedRowsFor(entities[0], knobs.seed_rows), configuration: { roles }, testInputs: { acting_roles: roles } },
    };
  },

  api_integration(ctx) {
    const { knobs, entities, params } = ctx;
    const fn = `${entities[0].name.toLowerCase()}Webhook`;
    const shape = { ok: "boolean", received: "number", entity: "string" };
    const checks = [
      mkCheck(0, "function_exists", fn, { function_name: fn, method: "POST" }, `A backend function ${fn} accepts POST.`),
      mkCheck(1, "api_behavior", fn, { function_name: fn, request: { entity: entities[0].name, rows: knobs.operations }, expect_status: 200, expect_shape: shape }, `${fn} answers 200 with the declared response shape.`),
      mkCheck(2, "api_behavior", fn, { function_name: fn, request: { invalid: true }, expect_status: 400 }, `${fn} rejects a malformed payload with 400.`),
      mkCheck(3, "entity_schema", entities[0].name, { entity: entities[0].name, required_fields: [...Object.keys(entities[0].fields), "external_id"] }, `${entities[0].name} stores the external_id of an ingested record.`),
      mkCheck(4, "data_invariant", entities[0].name, { entity: entities[0].name, rule: "idempotent_ingest", key_field: "external_id" }, "Re-delivering the same payload must not create a second record."),
    ];
    return {
      goal: `Implement a synthetic inbound integration: backend function ${fn} ingests ${entities[0].name} payloads (fields ${Object.keys(entities[0].fields).join(", ")} plus external_id), validates them against ${params.constraints.length} constraint(s), and answers ${JSON.stringify(shape)}. Ingest must be idempotent on external_id.`,
      expected_outcome_type: "integration_implemented",
      targets: { entities: [entities[0].name], files: [], routes: [], functions: [fn] },
      checks,
      invariants: [
        mkInvariant(0, "endpoint_shape", fn, { function_name: fn, expect_shape: shape }, `${fn} must return the declared shape.`),
        mkInvariant(1, "no_duplicate_records", entities[0].name, { entity: entities[0].name, unique_fields: ["external_id"] }, "No two records may share an external_id."),
      ],
      capabilities: ["code", "tools"],
      fixtureSpec: { seedEntities: [entities[0]], seedRows: seedRowsFor(entities[0], knobs.seed_rows), configuration: { endpoint: fn, response_shape: shape }, testInputs: { valid_payload: { entity: entities[0].name, external_id: "ext_1" }, invalid_payload: { entity: null } } },
    };
  },

  schema_migration(ctx) {
    const { rng, knobs, entities } = ctx;
    const legacy = entities[0];
    const added = pickN(rng, FIELDS.filter((f) => !(f in legacy.fields)), Math.max(1, knobs.constraints));
    const preserved = Object.keys(legacy.fields);
    const checks = [
      mkCheck(0, "entity_schema", legacy.name, { entity: legacy.name, required_fields: [...preserved, ...added] }, `${legacy.name} gains ${added.join(", ")} while keeping ${preserved.join(", ")}.`),
      mkCheck(1, "data_invariant", legacy.name, { entity: legacy.name, rule: "row_count_preserved", expect_rows: knobs.seed_rows }, `All ${knobs.seed_rows} seeded rows survive the migration.`),
      mkCheck(2, "data_invariant", legacy.name, { entity: legacy.name, rule: "fields_preserved", fields: preserved }, "No pre-existing field value is lost."),
      mkCheck(3, "build_succeeds", "project", { expect: "success" }, "The project builds after the migration."),
    ];
    return {
      goal: `Migrate the synthetic ${legacy.name} schema: add ${added.join(", ")} without losing any existing field (${preserved.join(", ")}) or any of the ${knobs.seed_rows} seeded rows. Dependency depth ${knobs.dependency_depth}.`,
      expected_outcome_type: "schema_migrated",
      targets: { entities: [legacy.name], files: [], routes: [], functions: [] },
      checks,
      invariants: [mkInvariant(0, "migration_preserves_fields", legacy.name, { entity: legacy.name, preserve_fields: preserved, preserve_row_count: knobs.seed_rows }, "The migration must preserve every listed field and every row.")],
      capabilities: ["code"],
      fixtureSpec: { seedEntities: [legacy], seedRows: seedRowsFor(legacy, knobs.seed_rows), configuration: { legacy_fields: preserved, add_fields: added }, testInputs: { expected_row_count: knobs.seed_rows } },
    };
  },

  debugging_repair(ctx) {
    const { knobs, entities } = ctx;
    const broken = "src/lib/total.js";
    const page = `src/pages/${entities[0].name}Summary.js`;
    const checks = [
      mkCheck(0, "build_succeeds", "project", { expect: "success" }, "The project builds after the repair."),
      mkCheck(1, "runtime_behavior", page, { path: page, expect: "renders_without_error" }, "The summary page renders without throwing."),
      mkCheck(2, "file_exists", broken, { path: broken, must_reference: "reduce" }, "The faulty module is repaired, not deleted."),
      mkCheck(3, "data_invariant", broken, { module: broken, function: "total", input: [1, 2, 3], expect_output: 6 }, "total([1,2,3]) must return 6."),
    ];
    const brokenFile = { path: broken, content: `${FIXTURE_HEADER}\n// BUG: the accumulator is never returned and the seed is wrong.\nexport function total(rows) {\n  rows.reduce((a, b) => a + b, null);\n}\n` };
    const pageFile = { path: page, content: `${FIXTURE_HEADER}\nimport { total } from '../lib/total.js';\nexport default function Summary({ rows }) { return String(total(rows)); }\n` };
    return {
      goal: `Repair the synthetic defect in ${broken}: total(rows) must sum a numeric array and return the sum (total([1,2,3]) === 6), so ${page} renders instead of throwing. Keep the module and its export; do not delete it. ${knobs.constraints} constraint(s) apply.`,
      expected_outcome_type: "bug_repaired",
      targets: { entities: [], files: [broken, page], routes: [], functions: [] },
      checks, invariants: [mkInvariant(0, "endpoint_shape", broken, { module: broken, function: "total", returns: "number" }, "total must return a number.")],
      capabilities: ["code"],
      fixtureSpec: { seedEntities: [], seedRows: [], configuration: { failing_module: broken }, testInputs: { rows: [1, 2, 3], expected: 6 }, extraFiles: [brokenFile, pageFile] },
    };
  },

  multi_step_workflow(ctx) {
    const { knobs, entities } = ctx;
    const states = STATES.slice(0, Math.max(3, Math.min(knobs.dependency_depth + 2, STATES.length)));
    const transitions = states.slice(0, -1).map((s, i) => ({ from: s, to: states[i + 1] }));
    const fn = `advance${entities[0].name}`;
    const checks = [
      mkCheck(0, "entity_schema", entities[0].name, { entity: entities[0].name, required_fields: [...Object.keys(entities[0].fields), "state"], enums: { state: states } }, `${entities[0].name} carries a state field limited to ${states.join(" → ")}.`),
      mkCheck(1, "function_exists", fn, { function_name: fn }, `A transition function ${fn} exists.`),
      mkCheck(2, "workflow_transition", entities[0].name, { entity: entities[0].name, allowed_transitions: transitions, expect_rejected: [{ from: states[states.length - 1], to: states[0] }] }, "Only the declared forward transitions are accepted."),
      mkCheck(3, "data_invariant", entities[0].name, { entity: entities[0].name, rule: "state_within_enum", enum: states }, "No record may hold a state outside the enum."),
    ];
    return {
      goal: `Implement a ${states.length}-state workflow for ${entities[0].name} (${states.join(" → ")}) with a transition function ${fn}. Only the declared forward transitions are legal; a backward transition must be rejected.`,
      expected_outcome_type: "workflow_implemented",
      targets: { entities: [entities[0].name], files: [], routes: [], functions: [fn] },
      checks,
      invariants: [mkInvariant(0, "valid_state_transition", entities[0].name, { entity: entities[0].name, allowed_transitions: transitions, terminal_states: [states[states.length - 1]] }, "Every state change must follow an allowed transition.")],
      capabilities: ["code"],
      fixtureSpec: { seedEntities: [{ ...entities[0], fields: { ...entities[0].fields, state: { type: "string" } } }], seedRows: seedRowsFor(entities[0], knobs.seed_rows), configuration: { states, transitions }, testInputs: { illegal_transition: { from: states[states.length - 1], to: states[0] } } },
    };
  },

  data_query(ctx) {
    const { knobs, entities } = ctx;
    const numeric = Object.entries(entities[0].fields).find(([, v]) => v.type === "number")?.[0] || "amount";
    const fn = `summarize${entities[0].name}`;
    const page = `src/pages/${entities[0].name}Report.js`;
    const expectedSum = Array.from({ length: knobs.seed_rows }, (_, i) => (i + 1) * 10).reduce((a, b) => a + b, 0);
    const checks = [
      mkCheck(0, "function_exists", fn, { function_name: fn }, `An aggregation function ${fn} exists.`),
      mkCheck(1, "data_invariant", fn, { function_name: fn, entity: entities[0].name, aggregate: "sum", field: numeric, expect_value: expectedSum, over_rows: knobs.seed_rows }, `${fn} sums ${numeric} across the ${knobs.seed_rows} seeded rows to ${expectedSum}.`),
      mkCheck(2, "file_exists", page, { path: page, must_reference: fn }, "A report page renders the aggregate."),
      mkCheck(3, "runtime_behavior", page, { path: page, expect: "renders_without_error" }, "The report page renders without error."),
      mkCheck(4, "entity_schema", entities[0].name, { entity: entities[0].name, required_fields: Object.keys(entities[0].fields) }, "The queried entity keeps its fields."),
    ];
    return {
      goal: `Build a data-heavy report over ${knobs.seed_rows} seeded ${entities[0].name} rows: an aggregation ${fn} returning sum(${numeric}) (expected ${expectedSum}) plus a report page ${page}. Do not mutate the seeded data.`,
      expected_outcome_type: "query_implemented",
      targets: { entities: [entities[0].name], files: [page], routes: [], functions: [fn] },
      checks,
      invariants: [
        mkInvariant(0, "no_duplicate_records", entities[0].name, { entity: entities[0].name, unique_fields: ["id"] }, "The query must not duplicate rows."),
        mkInvariant(1, "migration_preserves_fields", entities[0].name, { entity: entities[0].name, preserve_fields: Object.keys(entities[0].fields), preserve_row_count: knobs.seed_rows }, "Reporting must not alter the seeded data."),
      ],
      capabilities: ["code", "long_context"],
      fixtureSpec: { seedEntities: [entities[0]], seedRows: seedRowsFor(entities[0], knobs.seed_rows), configuration: { aggregate_field: numeric }, testInputs: { expected_sum: expectedSum } },
    };
  },

  architecture(ctx) {
    const { knobs, entities } = ctx;
    const modules = entities.slice(0, Math.max(2, knobs.components)).map((e) => `src/modules/${e.name.toLowerCase()}/index.js`);
    const registry = "src/modules/registry.js";
    const checks = modules.map((path, i) => mkCheck(i, "file_exists", path, { path, must_export: "default", max_dependency_depth: knobs.dependency_depth }, `Module ${i + 1} exists as its own file with a default export.`));
    checks.push(mkCheck(checks.length, "file_exists", registry, { path: registry, must_reference_all: modules }, "A registry composes every module."));
    checks.push(mkCheck(checks.length, "build_succeeds", "project", { expect: "success" }, "The restructured project builds."));
    checks.push(mkCheck(checks.length, "runtime_behavior", "src/app.js", { path: "src/app.js", expect: "renders_without_error" }, "The app still boots after restructuring."));
    return {
      goal: `Restructure the synthetic app into ${modules.length} independent modules (${modules.join(", ")}) composed by ${registry}, with a maximum dependency depth of ${knobs.dependency_depth}. Behaviour must not change.`,
      expected_outcome_type: "architecture_refactored",
      targets: { entities: [], files: [...modules, registry], routes: [], functions: [] },
      checks,
      invariants: [mkInvariant(0, "no_duplicate_records", registry, { registry, unique_fields: ["module_id"] }, "The registry must not register the same module twice.")],
      capabilities: ["code", "long_context"],
      fixtureSpec: { seedEntities: [], seedRows: [], configuration: { module_count: modules.length }, testInputs: {} },
    };
  },
};

export const generatorCategories = () => Object.keys(GENERATORS);

// --- parameter resolution ------------------------------------------------------

export const DEFAULT_PARAMETERS = { entity_count: null, component_count: null, name_pool_offset: 0, features: null, constraints: null, difficulty: null };

/**
 * Resolves the parameter set actually used: template defaults, then the caller's explicit narrowing.
 * A parameter the template does not declare is REFUSED — otherwise a task's content could vary
 * without the recorded parameter set explaining it.
 */
export function resolveParameters(template, parameters = {}) {
  const declared = { ...DEFAULT_PARAMETERS, ...(template.generation_parameters || {}) };
  const unknown = Object.keys(parameters || {}).filter((k) => !(k in declared));
  if (unknown.length) {
    throw Object.assign(new Error(`Unknown generation parameter(s): ${unknown.join(", ")}`), { status: 400, code: "UNKNOWN_PARAMETER" });
  }
  const merged = { ...declared, ...(parameters || {}) };
  const difficulty = String(merged.difficulty || template.difficulty || "medium");
  if (!DIFFICULTIES.includes(difficulty)) {
    throw Object.assign(new Error(`Unknown difficulty: ${difficulty}`), { status: 400, code: "UNKNOWN_DIFFICULTY" });
  }
  return { ...merged, difficulty };
}

// --- generation ----------------------------------------------------------------

/**
 * Generates ONE task. Pure and deterministic: identical (template_key, template_version, seed,
 * parameters, generator version) always yields an identical task and an identical fingerprint.
 */
export function generateTaskContent({ template, seed, parameters }) {
  const generate = GENERATORS[template.category];
  if (!generate) throw Object.assign(new Error(`Unknown task category: ${template.category}`), { status: 400, code: "UNKNOWN_CATEGORY" });
  const params = resolveParameters(template, parameters);
  const knobsBase = DIFFICULTY_KNOBS[params.difficulty];
  const knobs = {
    ...knobsBase,
    entities: Math.max(1, Math.min(Number(params.entity_count || knobsBase.entities), GEN_LIMITS.entities)),
    components: Math.max(1, Math.min(Number(params.component_count || knobsBase.components), GEN_LIMITS.components)),
  };

  // Every random draw comes from this one seeded stream, keyed by the full lineage — so a different
  // template version or generator version yields different content, deterministically.
  const rng = seededRng(`${GENERATOR_VERSION}|${template.template_key}|${template.version}|${template.category}|${params.difficulty}|${seed}|${JSON.stringify(params)}`);
  const nouns = pickN(rng, NOUNS, knobs.entities);
  const entities = nouns.map((n) => ({
    name: pascal(n),
    fields: Object.fromEntries(pickN(rng, FIELDS, Math.max(2, Math.min(knobs.constraints + 2, FIELDS.length))).map((f) => [f, { type: fieldType(f) }])),
  }));
  const ops = OPERATIONS.slice(0, knobs.operations);
  const constraints = params.constraints || Array.from({ length: knobs.constraints }, (_, i) => `constraint_${i + 1}: ${pickN(rng, FIELDS, 1)[0]} is required`);

  const out = generate({ rng, knobs, entities, ops, params: { ...params, constraints } });

  // Acceptance criteria are padded to the difficulty's stated validation-criteria count, so a
  // harder task is measured by strictly more checks — and the count is recorded, not implied.
  const checks = [...out.checks];
  let pad = 0;
  while (checks.length < knobs.validation_criteria && pad < GEN_LIMITS.checks) {
    const targetFile = out.targets.files[pad % Math.max(1, out.targets.files.length)];
    if (targetFile) checks.push(mkCheck(checks.length, "file_exists", targetFile, { path: targetFile }, `Required artifact ${targetFile} exists.`));
    else if (out.targets.entities.length) checks.push(mkCheck(checks.length, "entity_schema", out.targets.entities[pad % out.targets.entities.length], { entity: out.targets.entities[pad % out.targets.entities.length] }, "Required entity exists."));
    else checks.push(mkCheck(checks.length, "build_succeeds", "project", { expect: "success", attempt: pad + 1 }, "The project builds."));
    pad++;
  }
  if (!checks.some((c) => c.type === "build_succeeds")) checks.push(mkCheck(checks.length, "build_succeeds", "project", { expect: "success" }, "The project must build."));
  const trimmed = checks.slice(0, GEN_LIMITS.checks);

  const { initial_state, fixture } = buildFixture(out.fixtureSpec);
  const complexity = {
    difficulty: params.difficulty, entity_count: knobs.entities, component_count: knobs.components,
    operation_count: ops.length, dependency_depth: knobs.dependency_depth, constraint_count: constraints.length,
    acceptance_check_count: trimmed.length, invariant_count: out.invariants.length,
    seed_row_count: fixture.seed_rows.length, max_steps: knobs.max_steps, time_budget_ms: knobs.time_budget_ms,
    knobs,
  };

  return {
    parameters: params,
    category: template.category, difficulty: params.difficulty, complexity,
    definition: {
      goal: String(out.goal).slice(0, GEN_LIMITS.goal),
      success_criteria: `Every one of the ${trimmed.length} machine-checkable acceptance checks and ${out.invariants.length} invariant(s) holds. Natural language is descriptive only; the checks are authoritative.`,
      expected_outcome_type: out.expected_outcome_type,
      synthetic: true, generator_version: GENERATOR_VERSION,
    },
    initial_state, fixture,
    acceptance_criteria: { version: GENERATOR_VERSION, check_count: trimmed.length, check_types: [...new Set(trimmed.map((c) => c.type))], checks: trimmed },
    invariants: out.invariants.slice(0, GEN_LIMITS.invariants),
    required_capabilities: [...new Set([...(out.capabilities || []), ...(template.required_capabilities || [])])].slice(0, 12),
    targets: { entities: out.targets.entities, files: out.targets.files, routes: out.targets.routes, functions: out.targets.functions },
    // The #23-compatible projection: the generated checks decide these, so the exported BenchmarkTask
    // is measured by the same criteria the generator asserted.
    verification_criteria: {
      must_build: true,
      must_pass_runtime: trimmed.some((c) => c.type === "runtime_behavior"),
      expect_entities: [...new Set(trimmed.filter((c) => c.type === "entity_schema").map((c) => c.assert.entity).filter(Boolean))].slice(0, 20),
      expect_files: [...new Set(trimmed.filter((c) => c.type === "file_exists").map((c) => c.assert.path).filter(Boolean))].slice(0, 40),
      required_dimensions: ["task_completion", "build"],
    },
    max_steps: knobs.max_steps, time_budget_ms: knobs.time_budget_ms,
  };
}

/** Fingerprint of a generated task: its content AND the lineage that produced it. */
export const taskFingerprint = ({ template, seed, content }) => fingerprint("stask", {
  generator_version: GENERATOR_VERSION,
  template_key: template.template_key, template_version: template.version, category: template.category,
  seed: String(seed), parameters: content.parameters,
  definition: content.definition, initial_state: content.initial_state,
  acceptance_criteria: content.acceptance_criteria, invariants: content.invariants,
  targets: content.targets, complexity: content.complexity,
});

export const templateChecksum = (t) => fingerprint("stmpl", {
  template_key: t.template_key, version: t.version, category: t.category, difficulty: t.difficulty,
  description: t.description || null, required_capabilities: t.required_capabilities || [],
  generation_parameters: t.generation_parameters || {}, acceptance_criteria_spec: t.acceptance_criteria_spec || {},
  invariants_spec: t.invariants_spec || {}, fixture_requirements: t.fixture_requirements || {},
  expected_outcome_type: t.expected_outcome_type || null, generator_version: t.generator_version,
});