// Auditable teardown for certification suites. Every read/delete error is COLLECTED (never swallowed,
// never thrown), lookups page until exhausted (a capped drain is reported, never assumed complete),
// and a separate verification pass proves nothing remains. Rate-limit aware: HTTP 429 is retried
// with 1s/2s/4s backoff and every call is spaced by a short pause.
const PAGE = 100;
const MAX_ROUNDS = 50;
const PAUSE_MS = 150;
const BACKOFF_MS = [1000, 2000, 4000];
const msg = (e) => String(e?.message || e).slice(0, 200);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const is429 = (e) => Number(e?.status) === 429 || /rate limit/i.test(String(e?.message || ""));

async function call(fn, sleep) {
  await sleep(PAUSE_MS);
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!is429(e) || attempt >= BACKOFF_MS.length) throw e;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
}

/** Deletes every row matching `query`, page by page, until a short or empty page proves exhaustion. */
export async function drain(svc, entity, query, errors, sleep = realSleep) {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let rows;
    try { rows = await call(() => svc.entities[entity].filter(query, "created_date", PAGE), sleep); }
    catch (e) { errors.push({ op: "read", entity, query, error: msg(e) }); return; }
    if (!rows.length) return;
    let deleted = 0;
    for (const r of rows) {
      try { await call(() => svc.entities[entity].delete(r.id), sleep); deleted++; }
      catch (e) { errors.push({ op: "delete", entity, id: r.id, error: msg(e) }); }
    }
    // A short page was the last one; a page with no successful delete would be re-read forever.
    // Either way, anything still present is caught by the verification pass.
    if (rows.length < PAGE || !deleted) return;
  }
  errors.push({ op: "read", entity, query, error: `not exhausted after ${MAX_ROUNDS} pages of ${PAGE}` });
}

/** plan: [{ entity, query }] in deletion order. Returns collected errors and verified leftovers. */
export async function cleanupAndVerify(svc, plan, { sleep = realSleep } = {}) {
  const errors = [];
  for (const step of plan) await drain(svc, step.entity, step.query, errors, sleep);
  const leftovers = [];
  const verifyErrors = [];
  for (const { entity, query } of plan) {
    try {
      const rows = await call(() => svc.entities[entity].filter(query, "created_date", 1), sleep);
      if (rows.length) leftovers.push({ entity, query });
    } catch (e) { verifyErrors.push({ entity, query, error: msg(e) }); }
  }
  return { errors, leftovers, verifyErrors, ok: !errors.length && !leftovers.length && !verifyErrors.length };
}

export const cleanupDetail = (r) => r.ok ? "all temporary records deleted and verified absent"
  : JSON.stringify({ errors: r.errors.slice(0, 10), leftovers: r.leftovers, verify_errors: r.verifyErrors }).slice(0, 290);