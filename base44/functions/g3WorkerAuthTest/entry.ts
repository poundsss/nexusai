// G-3 verification: the worker-boundary guard authenticates every caller of the
// five background worker entry points and fails closed.
//   • workflow-invoked calls pass via the platform-injected x-workflow-run marker
//   • external callers without a secret are refused (401)
//   • a wrong or missing secret is refused, and an unconfigured secret refuses everyone
//   • the correct secret passes via both the header and the Bearer form
// The decision core is exercised with known inputs; entry-point enforcement is
// verified separately by invoking each guarded worker through the test harness
// (which presents no WORKER_SECRET): every one must answer 401.
import { workerAuthDecision, timingSafeEqual } from "../../shared/workerAuth.ts";

const mk = (headers) => new Request("https://quick-zip-snap.base44.app/functions/g3WorkerAuthTest", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
});

export default async function (req) {
  const SECRET = "probe-secret-value";
  const results = [];
  const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || null });

  // 1. Platform workflow marker: trusted even with no secret presented.
  const wf = workerAuthDecision(mk({ "x-workflow-run": "run_123" }), SECRET);
  check("workflow marker is trusted", wf.ok && wf.via === "workflow");

  // 2. Anonymous caller: refused with WORKER_AUTH_REQUIRED.
  const anon = workerAuthDecision(mk({}), SECRET);
  check("anonymous refused", !anon.ok && anon.code === "WORKER_AUTH_REQUIRED");

  // 3. Wrong secret: refused with WORKER_AUTH_INVALID.
  const wrong = workerAuthDecision(mk({ "x-worker-secret": "not-the-secret" }), SECRET);
  check("wrong secret refused", !wrong.ok && wrong.code === "WORKER_AUTH_INVALID");

  // 4. Correct secret via x-worker-secret: accepted.
  const okHeader = workerAuthDecision(mk({ "x-worker-secret": SECRET }), SECRET);
  check("correct secret via header accepted", okHeader.ok && okHeader.via === "secret");

  // 5. Correct secret via Authorization: Bearer: accepted.
  const okBearer = workerAuthDecision(mk({ authorization: `Bearer ${SECRET}` }), SECRET);
  check("correct secret via bearer accepted", okBearer.ok && okBearer.via === "secret");

  // 6. Fail closed: no configured secret means every external caller is refused.
  const unset = workerAuthDecision(mk({ "x-worker-secret": "anything" }), null);
  check("unconfigured secret fails closed", !unset.ok && unset.code === "WORKER_SECRET_NOT_CONFIGURED");

  // 7. Constant-time comparison behaves correctly.
  check("timingSafeEqual accepts equal", timingSafeEqual(SECRET, SECRET));
  check("timingSafeEqual rejects different", !timingSafeEqual(SECRET, SECRET + "x"));
  check("timingSafeEqual rejects prefix", !timingSafeEqual("abc", "abcd"));

  const failed = results.filter((r) => !r.pass);
  return Response.json({
    ok: failed.length === 0,
    passed: results.length - failed.length,
    total: results.length,
    results,
  });
}
