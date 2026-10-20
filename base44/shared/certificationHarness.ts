// Harness for certification suites that must hold NO delete capability at all.
//
// Identical check/refusal/summary semantics to shared/testHarness.ts — a check is recorded the same
// way, an expected refusal is asserted the same way, and a suite reports the same shape — with ONE
// deliberate difference: this module contains no purge, no cleanup and no delete of any kind.
//
// shared/testHarness.ts additionally exports `purgeBy` and `cleanupWorkspace`, which delete records
// through a DYNAMIC entity name (`svc.entities[name].delete(...)`) under a caller-supplied query.
// That shape is unbounded by construction — nothing about it names, at author time, which entities
// or which records it can remove — so any function that imports that module statically carries an
// arbitrary-Entity-delete capability whether or not it ever calls those helpers. A suite whose
// fixture is retired by scoped updates needs neither helper, so it imports this module instead and
// the capability simply does not exist in its graph.
//
// Suites that legitimately purge their own scratch rows keep using shared/testHarness.ts unchanged.

export const nowIso = () => new Date().toISOString();

/**
 * Runs one call and reports what the PLATFORM did with it: the value it produced, or the exact code
 * and status of its refusal. Same contract as the shared harness, so a refusal is asserted
 * identically across suites.
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

  // An expected failure is a real assertion: the call must throw, and when a code is given it must
  // be exactly that code — a different error is a failed check, not a pass.
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

export const harnessError = (harness, error) => {
  const { passed, failed, results } = harness.summary();
  return Response.json({ ok: false, error: error.message, stack: String(error.stack || "").slice(0, 800), passed, failed, results }, { status: 500 });
};