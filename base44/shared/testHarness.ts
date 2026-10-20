// Shared harness for the platform's executable verification suites.
//
// One place owns how a check is recorded, how an expected failure is asserted and how a scratch
// workspace is cleaned up, so every suite reports identically and no suite quietly invents its
// own pass/fail semantics.

export const nowIso = () => new Date().toISOString();

/**
 * Runs one call and reports what the PLATFORM did with it: the value it produced, or the exact code
 * and status of its refusal. Shared so every suite asserts a refusal the same way instead of each
 * inventing its own notion of "something went wrong".
 */
export async function captureCall(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (e) { return { threw: true, code: e.code || null, status: e.status || null, message: String(e.message || "") }; }
}

/** True when a captured call was refused with one of the expected HTTP statuses. */
export const wasRefused = (result, statuses = [401, 403, 404]) => !!result?.threw && statuses.includes(Number(result.status) || 0);

export function createHarness() {
  const results = [];

  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });
    return !!ok;
  };

  // An expected failure is a real assertion: the call must throw, and when a code is given it
  // must be exactly that code — a different error is a failed check, not a pass.
  const expectThrow = async (name, fn, code) => {
    try {
      await fn();
      return check(name, false, "no error thrown");
    } catch (e) {
      return check(name, code ? e.code === code : true, `${e.code || "ERROR"}: ${e.message}`);
    }
  };

  const summary = () => {
    const passed = results.filter((r) => r.ok).length;
    return { ok: passed === results.length, passed, failed: results.length - passed, failures: results.filter((r) => !r.ok), results };
  };

  return { results, check, expectThrow, summary };
}

export const harnessResponse = (harness) => Response.json(harness.summary());

/** Deletes every record matching a scratch query, for suites whose fixtures are project-scoped. */
export async function purgeBy(svc, entityName, query) {
  for (const row of await svc.entities[entityName].filter(query, "-created_date", 500).catch(() => [])) {
    await svc.entities[entityName].delete(row.id).catch(() => {});
  }
}

export const harnessError = (harness, error) => {
  const { passed, failed, results } = harness.summary();
  return Response.json({ ok: false, error: error.message, failures: results.filter((r) => !r.ok), stack: String(error.stack || "").slice(0, 800), passed, failed, results }, { status: 500 });
};

/**
 * Deletes every record a suite's scratch workspace produced, in dependency order, then the
 * workspace itself. Suites must leave no residue in a real account's data.
 */
const PROJECT_KEYED = ["ProjectFile", "ProjectVersion", "ProjectIndexEntry", "AppRecord", "AppEntity"];

export async function cleanupWorkspace(svc, workspace_id, entityNames = []) {
  if (!workspace_id) return;
  // Project-keyed rows (files, versions, app data) carry no workspace_id, so they are purged
  // per project BEFORE the workspace-keyed pass deletes the projects themselves.
  const projects = await svc.entities.Project.filter({ workspace_id }, "-created_date", 500).catch(() => []);
  for (const p of projects) {
    for (const name of PROJECT_KEYED) await purgeBy(svc, name, { project_id: p.id });
  }
  for (const name of entityNames) {
    const rows = await svc.entities[name].filter({ workspace_id }, "-created_date", 500).catch(() => []);
    for (const row of rows) await svc.entities[name].delete(row.id).catch(() => {});
  }
  await svc.entities.Workspace.delete(workspace_id).catch(() => {});
}