// Shared regression-harness checklist: one place for the ok/bad/expect/denied/allowed
// helpers every audit-test function uses, so test files stay about their scenarios.
export function makeChecks({ defaultDeniedCode = "WORKSPACE_INACTIVE" } = {}) {
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail: String(detail ?? "") });
  const bad = (name, detail) => checks.push({ name, ok: false, detail: String(detail ?? "") });
  const expect = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));
  const denied = async (name, fn, code = defaultDeniedCode) => {
    try { await fn(); bad(name, "no error thrown"); }
    catch (e) { expect(name, e.status === 403 && e.code === code, `${e.status} ${e.code}`); }
  };
  const allowed = async (name, fn) => {
    try { await fn(); ok(name, "allowed"); }
    catch (e) { bad(name, `${e.status || ""} ${e.code || ""} ${e.message}`); }
  };
  const failed = () => checks.filter((c) => !c.ok);
  return { checks, ok, bad, expect, denied, allowed, failed };
}