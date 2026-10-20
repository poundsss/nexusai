// Harness-only isolation for the two targeted runtime suites. No production module imports this.
// Real SDK storage and real product modules; no fake persistence, bypassed RLS or mocked checks.
import { encryptSecretValue, decryptSecretValue } from "./secretCrypto.ts";

const NS = "targeted_runtime_certification";
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const notFound = (e) => Number(e?.status || e?.response?.status) === 404;
const batches = async (items, fn) => {
  for (let i = 0; i < items.length; i += 3) await Promise.all(items.slice(i, i + 3).map(fn));
};
const parentRank = (name) => ({ ProjectSecret: 1, Project: 2, Workspace: 3, BillingPlan: 4 }[name] || 0);

async function deleteFixtureRows(raw, rows) {
  const errors = [], remaining = [], counts = {};
  // Finish all children before deleting a parent, not merely sorting concurrent requests.
  for (const rank of [0, 1, 2, 3, 4]) {
    await batches(rows.filter((r) => parentRank(r.entity) === rank), async (row) => {
      try { await raw.entities[row.entity].delete(row.id); }
      catch (e) { if (!notFound(e)) errors.push({ ...row, error: e.message }); }
    });
  }
  for (const name of [...new Set(rows.map((r) => r.entity))]) {
    const ids = [...new Set(rows.filter((r) => r.entity === name).map((r) => r.id))];
    counts[name] = ids.length;
    const found = await raw.entities[name].filter({ id: { $in: ids } }, "created_date", 500);
    remaining.push(...found.map((r) => ({ entity: name, id: r.id })));
  }
  return { verified: errors.length === 0 && remaining.length === 0, created_fixture_counts: counts, remaining, errors };
}

// Exact fixture identities recovered from the halted pass, NOT a name/regex sweep.
const HALTED_FIXTURES = {
  entity_write_contracts: { workspaces: ["6ac3ebc204f687a96c283500"], projects: ["6ac3ebd6e7d981f5c09643e0", "6ac3ebd53f09d7e04bd58ea6", "6ac3ebd31cba828a46f34e2d"], from: "2026-10-05T18:26:00Z", until: "2026-10-05T18:31:10Z", namePrefix: "p911wc-proj-", planPrefix: "test_p911wc1791224766848_" },
  app_auth: { workspaces: ["6ac3e1f43fcd774b1282553e"], projects: ["6ac3e1f6ff7ff604aafb5410", "6ac3e1f56ec3feca8bebc4f6"], from: "2026-10-05T17:44:00Z", until: "2026-10-05T17:49:20Z" },
};

async function cleanupHaltedFixtures(raw, suite) {
  const fixture = HALTED_FIXTURES[suite];
  if (!fixture || Date.now() <= Date.parse(fixture.until) + 300000) throw fail("CERT_OLD_RUN_NOT_QUIESCENT", "The prior invocation's hard deadline has not elapsed");
  const rows = [], plans = new Set();
  for (const id of fixture.projects) {
    let p;
    try { p = await raw.entities.Project.get(id); } catch (e) { if (!notFound(e)) throw e; }
    if (!p) continue;
    const nameMatches = fixture.namePrefix ? p.name.startsWith(fixture.namePrefix) : ["Auth Cert App", "Other App"].includes(p.name);
    if (!fixture.workspaces.includes(p.workspace_id) || !nameMatches || p.created_date < fixture.from || p.created_date >= fixture.until || p.production_deployment_id || p.staging_deployment_id) throw fail("CERT_LEGACY_PROVENANCE_DENIED", "Prior project no longer matches the exact disposable fixture");
    rows.push({ entity: "Project", id });
  }
  for (const id of fixture.workspaces) {
    const projects = await raw.entities.Project.filter({ workspace_id: id }, "created_date", 500);
    if (projects.some((p) => !fixture.projects.includes(p.id))) throw fail("CERT_LEGACY_PROVENANCE_DENIED", "The old fixture workspace contains an unrecognized project");
    let w;
    try { w = await raw.entities.Workspace.get(id); } catch (e) { if (!notFound(e)) throw e; }
    if (w) {
      const ok = suite === "app_auth" ? w.name === "AppAuth #29 Cert" && String(w.owner_id).startsWith("aa-") : w.name.startsWith("billing-test p911wc1791224766848 ") && String(w.owner_id).startsWith("billing_owner_p911wc1791224766848_");
      if (!ok || w.created_date < fixture.from || w.created_date >= fixture.until) throw fail("CERT_LEGACY_PROVENANCE_DENIED", "Old workspace provenance mismatch");
      rows.push({ entity: "Workspace", id });
    }
  }
  const entities = ["AppRecord", "AppEntity", "AppRelation", "AppUser", "AppSession", "AppAuthToken", "AppIdentity", "AppRole", "AppTeam", "AppTeamMember", "ProjectSecret", "FunctionInvocation", "TraceEvent", "AuditLog", "WorkflowDefinition", "WorkflowRun", "WorkflowStepRun", "BackgroundJob", "DataCheckpoint", "DataRestoreOperation", "DataRestoreBatch"];
  for (const name of entities) {
    const found = await raw.entities[name].filter({ project_id: { $in: fixture.projects } }, "created_date", 500);
    if (found.length === 500 || found.some((r) => r.created_date < fixture.from || r.created_date >= fixture.until)) throw fail("CERT_LEGACY_PROVENANCE_DENIED", `Unbounded or out-of-window ${name} fixture records`);
    rows.push(...found.map((r) => ({ entity: name, id: r.id })));
  }
  for (const name of ["Subscription", "CreditLedgerEntry", "BillingEvent", "AIOperation", "RateLimitBucket"]) {
    const found = await raw.entities[name].filter({ workspace_id: { $in: fixture.workspaces } }, "created_date", 500);
    if (found.length === 500 || found.some((r) => r.created_date < fixture.from || r.created_date >= fixture.until)) throw fail("CERT_LEGACY_PROVENANCE_DENIED", `Out-of-window ${name} fixture records`);
    if (name === "Subscription") for (const r of found) if (r.plan_code) plans.add(r.plan_code);
    rows.push(...found.map((r) => ({ entity: name, id: r.id })));
  }
  for (const code of plans) {
    if (!fixture.planPrefix || !code.startsWith(fixture.planPrefix)) throw fail("CERT_LEGACY_PROVENANCE_DENIED", "Old fixture subscribed to a non-fixture plan");
    const found = await raw.entities.BillingPlan.filter({ code }, "created_date", 2);
    if (found.some((p) => p.visibility !== "hidden" || p.created_date < fixture.from || p.created_date >= fixture.until)) throw fail("CERT_LEGACY_PROVENANCE_DENIED", "Old plan provenance mismatch");
    rows.push(...found.map((p) => ({ entity: "BillingPlan", id: p.id })));
  }
  const cleanup = await deleteFixtureRows(raw, rows);
  return Response.json({ result: cleanup.verified ? "CLEAN" : "BLOCKED", cleanup, termination: { hard_deadline_elapsed: true, explicit_worker_termination_verified: false, reason: "The platform terminates requests after five minutes; no direct cancellation or invocation-status API is documented" } });
}

export async function openCertification(client, req, suite, phases) {
  const user = await client.auth.me();
  if (user?.role !== "admin") throw fail("CERT_ADMIN_REQUIRED", "Only an administrator can run this certification", 403);
  const raw = client.asServiceRole;
  const input = await req.json().catch(() => ({}));
  if (Object.keys(input).some((key) => !["action", "run_id"].includes(key))) throw fail("CERT_INPUT_INVALID", "Only action and run_id are accepted", 400);
  const action = input.action || (input.run_id ? "continue" : "start");
  if (!["start", "continue", "inspect", "cancel", "cleanup_halted"].includes(action)) throw fail("CERT_INPUT_INVALID", "Unknown certification action", 400);
  if (action === "cleanup_halted") {
    if (input.run_id) throw fail("CERT_INPUT_INVALID", "Legacy cleanup cannot accept a caller-selected run", 400);
    return { immediate: await cleanupHaltedFixtures(raw, suite) };
  }
  let checkpoint, state;
  if (action === "start") {
    if (input.run_id) throw fail("CERT_INPUT_INVALID", "A start cannot accept an existing run", 400);
    const tag = `cert_${suite}_${crypto.randomUUID().replaceAll("-", "")}`;
    state = { suite, owner_id: user.id, tag, started_at: new Date().toISOString(), phase: 0, phases, status: "paused", rows: [], results: [], violations: [], locals_secret_id: null };
    checkpoint = await raw.entities.CacheEntry.create({ namespace: NS, cache_key: tag, value: state, expires_at: new Date(Date.now() + 86400000).toISOString() });
  } else {
    if (typeof input.run_id !== "string" || !/^[a-f0-9]{24}$/.test(input.run_id)) throw fail("CERT_INPUT_INVALID", "A valid run_id is required", 400);
    checkpoint = await raw.entities.CacheEntry.get(input.run_id);
    state = checkpoint.value;
    if (checkpoint.namespace !== NS || state?.suite !== suite || state?.owner_id !== user.id || state?.tag !== checkpoint.cache_key) throw fail("CERT_RUN_FORBIDDEN", "This is not your certification run", 403);
  }
  const save = () => raw.entities.CacheEntry.update(checkpoint.id, { value: state });
  const owned = (name, id) => state.rows.some((r) => r.entity === name && r.id === id);
  const idsOf = (name) => state.rows.filter((r) => r.entity === name).map((r) => r.id);
  const started = Date.now();
  let cleanupMode = false;
  const guard = () => {
    if (!cleanupMode && (req.signal?.aborted || Date.now() - started >= 190000)) throw fail("CERT_BUDGET_EXHAUSTED", "Certification phase stopped before the platform timeout", 503);
  };
  const deny = (message) => { state.violations.push(message); throw fail("CERT_ISOLATION_DENIED", message, 403); };
  const scope = (name, data) => {
    if (name === "Workspace") return typeof data.name === "string" && data.name.includes(state.tag) && String(data.owner_id || "").includes(state.tag);
    if (name === "BillingPlan") return data.visibility === "hidden" && String(data.code || "").includes(state.tag);
    if (name === "User") return false;
    if (data.project_id != null && !owned("Project", data.project_id)) return false;
    if (data.workspace_id != null && !owned("Workspace", data.workspace_id)) return false;
    if (data.project_id != null || data.workspace_id != null) return true;
    return name === "RateLimitBucket" && idsOf("Project").some((id) => String(data.identity || "").startsWith(`app:${id}:`));
  };
  const mutating = async () => {
    guard();
    const current = await raw.entities.CacheEntry.get(checkpoint.id);
    if (current.value?.cancel_requested) throw fail("CERT_CANCELLED", "Certification cancellation requested", 409);
  };
  const handlers = new Map();
  const entities = new Proxy({}, { get(_, name) {
    if (typeof name !== "string") return undefined;
    if (handlers.has(name)) return handlers.get(name);
    const native = raw.entities[name];
    const handler = {
      get: async (...args) => { guard(); return native.get(...args); },
      filter: async (...args) => { guard(); return native.filter(...args); },
      list: async (...args) => { guard(); return native.list(...args); },
      create: async (data) => {
        await mutating();
        if (!scope(name, data)) deny(`Unscoped ${name} creation refused`);
        const row = await native.create(data);
        state.rows.push({ entity: name, id: row.id });
        if (["Workspace", "Project", "BillingPlan"].includes(name)) await save();
        return row;
      },
      update: async (id, data) => {
        await mutating();
        if (!owned(name, id)) deny(`Update of a non-fixture ${name} refused`);
        if (data.project_id != null && !owned("Project", data.project_id)) deny("Foreign project reassignment refused");
        if (data.workspace_id != null && !owned("Workspace", data.workspace_id)) deny("Foreign workspace reassignment refused");
        return native.update(id, data);
      },
      delete: async (id) => {
        await mutating();
        if (!owned(name, id)) deny(`Deletion of a non-fixture ${name} refused`);
        return native.delete(id);
      },
    };
    for (const operation of ["bulkCreate", "bulkUpdate", "updateMany", "deleteMany"]) handler[operation] = async () => deny(`Untracked storage ${name}.${operation} refused`);
    handlers.set(name, handler);
    return handler;
  } });
  const db = { entities };
  db.asServiceRole = db;

  async function cleanup() {
    cleanupMode = true;
    state.status = "cleaning";
    await save();
    const evidence = { ...(await deleteFixtureRows(raw, state.rows)), outside_fixture_mutations: 0, isolation_violations: state.violations, run_id: checkpoint.id };
    if (evidence.verified) {
      await raw.entities.CacheEntry.delete(checkpoint.id);
      const check = await raw.entities.CacheEntry.filter({ id: checkpoint.id }, "created_date", 1);
      evidence.checkpoint_removed = check.length === 0;
      evidence.verified = evidence.checkpoint_removed;
    } else {
      state.status = "cleanup_blocked";
      await save();
    }
    return evidence;
  }

  if (action === "inspect") return { immediate: Response.json({ run_id: checkpoint.id, suite, phase: state.phase, status: state.status, phase_started_at: state.phase_started_at || null, fixture_count: state.rows.length }) };
  if (action === "cancel") {
    state.cancel_requested = true;
    await save();
    if (state.status === "running" && Date.now() - Date.parse(state.phase_started_at) < 300000) return { immediate: Response.json({ run_id: checkpoint.id, status: "cancellation_requested", terminated: false }, { status: 202 }) };
    // A paused run has no worker. A running phase older than five minutes is subject to the
    // platform's documented hard termination; no new phase or product operation is dispatched.
    return { immediate: Response.json({ run_id: checkpoint.id, status: "cancelled", cleanup: await cleanup(), termination: state.status === "paused" ? "no phase in flight" : "platform five-minute deadline elapsed; worker termination not independently observable" }) };
  }
  if (state.status !== "paused" || state.cancel_requested) throw fail("CERT_RUN_NOT_PAUSED", "Inspect or cancel the existing phase before continuing");
  if (Date.parse(checkpoint.expires_at) <= Date.now()) throw fail("CERT_RUN_EXPIRED", "Cancel and clean up the expired certification run");
  state.status = "running";
  state.phase_started_at = new Date().toISOString();
  await save();
  let locals = {};
  if (state.locals_secret_id) {
    if (!owned("ProjectSecret", state.locals_secret_id)) throw fail("CERT_STATE_INVALID", "Unowned checkpoint secret");
    const saved = await raw.entities.ProjectSecret.get(state.locals_secret_id);
    locals = JSON.parse(await decryptSecretValue(saved.project_id, saved.name, saved.value));
  }
  async function pause(nextLocals, results) {
    guard();
    if (state.violations.length) throw fail("CERT_ISOLATION_DENIED", "A certification dependency attempted an unscoped mutation", 403);
    const projectId = idsOf("Project")[0];
    const name = "CERTIFICATION_STATE";
    const value = await encryptSecretValue(projectId, name, JSON.stringify(nextLocals));
    if (state.locals_secret_id) await raw.entities.ProjectSecret.update(state.locals_secret_id, { value });
    else {
      const row = await raw.entities.ProjectSecret.create({ project_id: projectId, name, value, description: state.tag, access: "backend_only", required: false });
      state.locals_secret_id = row.id;
      state.rows.push({ entity: "ProjectSecret", id: row.id });
    }
    state.results = results;
    state.phase++;
    state.status = "paused";
    await save();
    return Response.json({ complete: false, result: "IN_PROGRESS", run_id: checkpoint.id, phase_completed: state.phase - 1, next_phase: state.phase, phases, checks_so_far: results.length, failures_so_far: results.filter((r) => !r.ok), fixture_only: true });
  }
  async function finish(results, error = null) {
    state.results = results;
    const evidence = await cleanup();
    const failed = results.filter((r) => !r.ok);
    const blocked = !!error || !evidence.verified || state.violations.length > 0;
    return Response.json({ complete: !error, result: blocked ? "BLOCKED" : failed.length ? "FAIL" : "PASS", ok: !blocked && !failed.length, passed: results.length - failed.length, failed: failed.length, failures: failed, results, ...(error ? { blocker: { code: error.code || "CERT_HARNESS_ERROR", message: error.message } } : {}), cleanup: evidence, termination: "phase returned after awaiting all operations; no background continuation scheduled" }, { status: blocked ? 503 : 200 });
  }
  return { db, state, locals, pause, finish };
}