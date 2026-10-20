// E2E certification of server-side BillingPlan enforcement: seats, projects, domains, usage
// limits and overage policy — against the REAL enforcement paths (shared/planLimits.ts through
// projectCreate, the budget gate and beginOperation), with real concurrency.
//
// Every fixture (plans, subscriptions, workspaces, rows they produce) is scratch and removed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createMemberWithinSeats, createDomainWithinLimit, effectivePlan } from "../../shared/planLimits.ts";
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { beginOperation, settleUsage } from "../../shared/aiOperations.ts";
import { recordEvent, deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { estimateMaxCharge, loadCreditPolicy } from "../../shared/economics.ts";
import { makeBillingPlan, makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";

const MODEL_ID = "gemini-3-flash";
const MODEL = { model_id: MODEL_ID, id: MODEL_ID, provider: "base44-core", upstream_provider: "google", name: "gemini_3_flash" };
const ESTIMATE = { max_input_tokens: 60000, max_output_tokens: 12000 };
const USAGE = { input_tokens: 24000, output_tokens: 3000 };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const stamp = Date.now();
  const created = { plans: [], workspaces: [] };
  // The full suite exceeds one request's API rate budget, so it runs in parts: { from, to }.
  const body = await req.json().catch(() => ({}));
  const from = Number(body.from) || 1, to = Number(body.to) || 15;
  const want = (n) => n >= from && n <= to;

  const makePlan = (label, overrides) => makeBillingPlan(svc, created, label, overrides, stamp);
  const makeWorkspace = (label, plan, credits = 0) => makeBillingWorkspace(svc, created, label, { plan, credits }, stamp);
  const members = async (ws) => (await svc.entities.WorkspaceMember.filter({ workspace_id: ws.id }, "-created_date", 100)).filter((m) => m.status !== "removed");
  const projects = (ws) => svc.entities.Project.filter({ workspace_id: ws.id }, "-created_date", 100);
  const domains = async (ws) => (await svc.entities.CustomDomain.filter({ workspace_id: ws.id }, "-created_date", 100)).filter((d) => d.status !== "removed");
  const ops = (ws) => svc.entities.AIOperation.filter({ workspace_id: ws.id }, "-created_date", 100);
  const ledger = (ws) => svc.entities.CreditLedgerEntry.filter({ workspace_id: ws.id }, "-created_date", 100);
  const invite = (ws, i) => createMemberWithinSeats(svc, ws, { email: `m${i}-${stamp}@example.com`, role: "viewer", status: "invited", invite_token: `t${i}${stamp}` });
  const addDomain = (ws, projectId, i) => createDomainWithinLimit(svc, ws, { project_id: projectId, hostname: `d${i}-${stamp}.example.org`, environment: "production", status: "pending_verification", verification_method: "dns_txt", verification_host: `_nexus-verify.d${i}-${stamp}.example.org`, verification_token: `tok${i}`, is_primary: false, added_by: "test" });
  const settledCount = (results) => results.filter((r) => r.status === "fulfilled").length;
  const allRefusedByPlan = (results) => results.filter((r) => r.status === "rejected").every((r) => r.reason?.code === "PLAN_LIMIT_REACHED");
  const runOp = (ws, runId, extra = {}) => beginOperation(svc, { workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model_id: MODEL_ID, idempotency_key: `run:${runId}`, estimate: ESTIMATE, ...extra });
  const planCodeOf = (e) => (e?.detail?.violations || []).map((v) => v.code);

  try {
    const policy = await loadCreditPolicy(svc, null);
    const reservation = estimateMaxCharge({ model_id: MODEL_ID, ...ESTIMATE, operation_type: "ai_run", policy }).credits;

    // 1. Seat limit enforced -------------------------------------------------------
    if (want(1)) {
      const plan = await makePlan("seats2", { limits: { seats: 2 } });
      const { ws } = await makeWorkspace("seats", plan);
      const first = await invite(ws, 1);
      await expectThrow("1. seat limit enforced: second seat beyond the plan refused", () => invite(ws, 2), "PLAN_LIMIT_REACHED");
      const rows = await members(ws);
      check("1. seat limit enforced: existing member remains valid, no extra row", rows.length === 1 && rows[0].id === first.id, `${rows.length} member row(s)`);
    }

    // 2. Seat limit concurrency-safe --------------------------------------------------
    if (want(2)) {
      const plan = await makePlan("seats3", { limits: { seats: 3 } });
      const { ws } = await makeWorkspace("seatsconc", plan);
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => invite(ws, i)));
      const rows = await members(ws);
      check("2. seat limit concurrency-safe: 6 parallel invites, exactly 2 seats granted",
        settledCount(results) === 2 && rows.length === 2 && allRefusedByPlan(results), `${settledCount(results)} fulfilled, ${rows.length} rows`);
    }

    // 3. Project limit enforced -------------------------------------------------------
    if (want(3)) {
      const plan = await makePlan("proj1", { limits: { projects: 1 } });
      const { ws, user } = await makeWorkspace("proj", plan);
      const ok = await createProjectForUser(svc, user, { workspace_id: ws.id, name: "First" });
      await expectThrow("3. project limit enforced: creation above the limit refused", () => createProjectForUser(svc, user, { workspace_id: ws.id, name: "Second" }), "PLAN_LIMIT_REACHED");
      const rows = await projects(ws);
      const versions = await svc.entities.ProjectVersion.filter({ project_id: ok.project.id }, "-number", 5);
      check("3. project limit enforced: one project with its scaffold, nothing else", rows.length === 1 && rows[0].id === ok.project.id && versions.length === 1, `${rows.length} project(s)`);
    }

    // 4. Project limit concurrency-safe ----------------------------------------------
    if (want(4)) {
      const plan = await makePlan("proj2", { limits: { projects: 2 } });
      const { ws, user } = await makeWorkspace("projconc", plan);
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => createProjectForUser(svc, user, { workspace_id: ws.id, name: `P${i}` })));
      const rows = await projects(ws);
      const files = (await Promise.all(rows.map((p) => svc.entities.ProjectFile.filter({ project_id: p.id }, "path", 50)))).map((f) => f.length);
      check("4. project limit concurrency-safe: 6 parallel creates, exactly 2 projects exist, each scaffolded",
        settledCount(results) === 2 && rows.length === 2 && files.every((n) => n > 0) && allRefusedByPlan(results), `${settledCount(results)} fulfilled, ${rows.length} rows, files ${files.join("/")}`);
    }

    // 5. Domain limit enforced ---------------------------------------------------------
    if (want(5)) {
      const plan = await makePlan("dom1", { limits: { custom_domains: 1 } });
      const { ws, user } = await makeWorkspace("dom", plan);
      const { project } = await createProjectForUser(svc, user, { workspace_id: ws.id, name: "Dom" });
      await addDomain(ws, project.id, 1);
      await expectThrow("5. domain limit enforced: second domain refused", () => addDomain(ws, project.id, 2), "PLAN_LIMIT_REACHED");
      check("5. domain limit enforced: exactly one domain row", (await domains(ws)).length === 1);
      const zero = await makePlan("dom0", { limits: { custom_domains: 0 } });
      const z = await makeWorkspace("domzero", zero);
      const zp = await createProjectForUser(svc, z.user, { workspace_id: z.ws.id, name: "Zero" });
      await expectThrow("5. domain limit enforced: a zero-domain plan refuses the first domain", () => addDomain(z.ws, zp.project.id, 1), "PLAN_LIMIT_REACHED");
    }

    // 6. Domain limit concurrency-safe -------------------------------------------------
    if (want(6)) {
      const plan = await makePlan("dom2", { limits: { custom_domains: 2 } });
      const { ws, user } = await makeWorkspace("domconc", plan);
      const { project } = await createProjectForUser(svc, user, { workspace_id: ws.id, name: "DomC" });
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => addDomain(ws, project.id, i)));
      const rows = await domains(ws);
      check("6. domain limit concurrency-safe: 6 parallel adds, exactly 2 domains", settledCount(results) === 2 && rows.length === 2 && allRefusedByPlan(results), `${settledCount(results)} fulfilled, ${rows.length} rows`);
    }

    // 7. Usage limits enforced ---------------------------------------------------------
    if (want(7)) {
      const perRun = await makePlan("perrun", { usage_limits: { credits_per_run: reservation - 1 } });
      const a = await makeWorkspace("perrun", perRun, reservation * 10);
      let err = null;
      try { await runOp(a.ws, `r_${stamp}_a`); } catch (e) { err = e; }
      check("7. usage limit enforced: credits_per_run refuses a run whose worst case exceeds it", err?.code === "BUDGET_EXCEEDED" && planCodeOf(err).includes("PLAN_RUN_CREDITS_EXCEEDED"), `${err?.code}: ${planCodeOf(err)}`);
      check("7. usage limit enforced: refusal created no operation and held no credits", (await ops(a.ws)).length === 0 && (await deriveBalance(svc, a.ws.id)).reserved === 0);

      const monthly = await makePlan("monthly", { usage_limits: { monthly_credits: reservation + 1 } });
      const b = await makeWorkspace("monthly", monthly, reservation * 10);
      const firstOp = await runOp(b.ws, `r_${stamp}_b1`);
      err = null;
      try { await runOp(b.ws, `r_${stamp}_b2`); } catch (e) { err = e; }
      check("7. usage limit enforced: monthly_credits counts in-flight holds and refuses the second run", firstOp.operation && err?.code === "BUDGET_EXCEEDED" && planCodeOf(err).includes("PLAN_MONTHLY_CREDITS_EXCEEDED"), `${err?.code}: ${planCodeOf(err)}`);

      const conc = await makePlan("conc2", { usage_limits: { concurrent_runs: 2 } });
      const c = await makeWorkspace("conc", conc, reservation * 20);
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => runOp(c.ws, `r_${stamp}_c${i}`)));
      const running = (await ops(c.ws)).filter((o) => o.status === "running" && !o.finalized_at);
      const bal = await deriveBalance(svc, c.ws.id);
      check("7. usage limit concurrency-safe: 6 parallel runs, exactly 2 running and only 2 reservations held",
        settledCount(results) === 2 && running.length === 2 && Math.abs(bal.reserved - 2 * reservation) < 1e-6 &&
        results.filter((r) => r.status === "rejected").every((r) => r.reason?.code === "BUDGET_EXCEEDED"),
        `${settledCount(results)} fulfilled, ${running.length} running, reserved ${bal.reserved}`);
    }

    // 8. Overage allowed follows policy ------------------------------------------------
    if (want(8)) {
      const plan = await makePlan("overok", { included_credits: 1, overage_policy: "allow_overage" });
      const { ws } = await makeWorkspace("overok", plan, reservation * 4);
      const { operation } = await runOp(ws, `r_${stamp}_ov`);
      const settled = await settleUsage(svc, { workspace_id: ws.id, run_id: `r_${stamp}_ov`, operation_type: "ai_run", model: MODEL, usage: USAGE, idempotency_key: `run:r_${stamp}_ov`, status: "completed" });
      const after = await deriveBalance(svc, ws.id);
      check("8. overage allowed: purchased credits spendable past included credits, settled normally",
        !!operation && settled.credits_charged > 0 && after.reserved === 0 && (await verifyBalanceIntegrity(svc, ws.id)).ok, `charged ${settled.credits_charged}, balance ${after.balance}`);
    }

    // 9. Overage disallowed rejects before side effects --------------------------------
    if (want(9)) {
      const plan = await makePlan("overblock", { included_credits: reservation - 1, overage_policy: "block" });
      const { ws } = await makeWorkspace("overblock", plan, reservation * 4);
      const entriesBefore = (await ledger(ws)).length;
      let err = null;
      try { await runOp(ws, `r_${stamp}_blk`); } catch (e) { err = e; }
      check("9. overage disallowed: refused with OVERAGE_BLOCKED before any spend", err?.code === "BUDGET_EXCEEDED" && planCodeOf(err).includes("OVERAGE_BLOCKED"), `${err?.code}: ${planCodeOf(err)}`);
      // 10. Rejected operations create no unintended resources
      check("10. rejected operations create no resources: no operation, no ledger movement, balance intact",
        (await ops(ws)).length === 0 && (await ledger(ws)).length === entriesBefore && (await deriveBalance(svc, ws.id)).available === reservation * 4);
    }

    // 11 + 12. Correct workspace limits, cross-workspace isolation ---------------------
    if (want(11)) {
      const tight = await makePlan("tight", { limits: { projects: 1 } });
      const roomy = await makePlan("roomy", { limits: { projects: 5 } });
      const A = await makeWorkspace("isoA", tight);
      const B = await makeWorkspace("isoB", roomy);
      await createProjectForUser(svc, A.user, { workspace_id: A.ws.id, name: "A1" });
      await createProjectForUser(svc, B.user, { workspace_id: B.ws.id, name: "B1" });
      await createProjectForUser(svc, B.user, { workspace_id: B.ws.id, name: "B2" });
      await expectThrow("11. correct workspace limits: A's tight plan refuses while B's plan still allows", () => createProjectForUser(svc, A.user, { workspace_id: A.ws.id, name: "A2" }), "PLAN_LIMIT_REACHED");
      check("11. correct workspace limits: each workspace evaluated against its own plan", (await projects(A.ws)).length === 1 && (await projects(B.ws)).length === 2 && (await effectivePlan(svc, A.ws.id)).plan.code === tight.code && (await effectivePlan(svc, B.ws.id)).plan.code === roomy.code);
      await expectThrow("12. cross-workspace isolation: A's owner cannot create in B by supplying B's id", () => createProjectForUser(svc, A.user, { workspace_id: B.ws.id, name: "Intruder" }), "NOT_A_MEMBER");
      check("12. cross-workspace isolation: B's count and limit untouched by A", (await projects(B.ws)).length === 2 && (await projects(A.ws)).length === 1);
    }

    // 13. Plan changes immediately affect enforcement -----------------------------------
    if (want(13)) {
      const plan = await makePlan("mutable", { limits: { projects: 1 } });
      const { ws, user } = await makeWorkspace("mutable", plan);
      await createProjectForUser(svc, user, { workspace_id: ws.id, name: "M1" });
      await expectThrow("13. plan change: refused at the original limit", () => createProjectForUser(svc, user, { workspace_id: ws.id, name: "M2" }), "PLAN_LIMIT_REACHED");
      await svc.entities.BillingPlan.update(plan.id, { limits: { projects: 2 } });
      const raised = await createProjectForUser(svc, user, { workspace_id: ws.id, name: "M2" }).catch((e) => ({ error: e }));
      check("13. plan change: raising the plan's limit takes effect on the next request", !!raised.project, raised.error?.message || "created");
      const bigger = await makePlan("bigger", { limits: { projects: 3 } });
      const sub = (await svc.entities.Subscription.filter({ workspace_id: ws.id }, "-updated_date", 1))[0];
      await expectThrow("13. plan change: still refused at the raised limit", () => createProjectForUser(svc, user, { workspace_id: ws.id, name: "M3" }), "PLAN_LIMIT_REACHED");
      await svc.entities.Subscription.update(sub.id, { plan_code: bigger.code });
      const moved = await createProjectForUser(svc, user, { workspace_id: ws.id, name: "M3" }).catch((e) => ({ error: e }));
      check("13. plan change: switching the subscription's plan takes effect immediately", !!moved.project && (await projects(ws)).length === 3, moved.error?.message || "created");
      // A lapsed subscription falls back to the free plan's limits, so entitlements are never kept for free.
      await svc.entities.Subscription.update(sub.id, { status: "expired" });
      check("13. plan change: a lapsed subscription is governed by the free plan", (await effectivePlan(svc, ws.id)).plan.code === "free");
    }

    // 14. Unlimited configuration -----------------------------------------------------
    if (want(14)) {
      const plan = await makePlan("unlimited", { limits: { projects: -1, seats: null, custom_domains: -1 }, usage_limits: {}, overage_policy: "allow_overage", included_credits: 0 });
      const { ws, user } = await makeWorkspace("unlimited", plan, reservation * 10);
      // Sequential on purpose: this case proves the absence of a limit, not concurrency.
      const results = []; for (const i of [1, 2, 3, 4, 5]) results.push(await createProjectForUser(svc, user, { workspace_id: ws.id, name: `U${i}` }).then((v) => ({ status: "fulfilled", value: v }), (e) => ({ status: "rejected", reason: e })));
      const seatResults = []; for (const i of [1, 2, 3, 4]) seatResults.push(await invite(ws, i).then((v) => ({ status: "fulfilled", value: v }), (e) => ({ status: "rejected", reason: e })));
      const { operation } = await runOp(ws, `r_${stamp}_unl`);
      check("14. unlimited configuration: no limit on projects, seats or usage when none is configured",
        settledCount(results) === 5 && settledCount(seatResults) === 4 && !!operation, `${settledCount(results)} projects, ${settledCount(seatResults)} seats`);
      await settleUsage(svc, { workspace_id: ws.id, run_id: `r_${stamp}_unl`, operation_type: "ai_run", model: MODEL, usage: USAGE, idempotency_key: `run:r_${stamp}_unl`, status: "completed" });
    }

    // 15. Existing valid operations and settlement unchanged ---------------------------
    if (want(15)) {
      const plan = await makePlan("normal", { limits: { projects: 50, seats: 5, custom_domains: 3 }, usage_limits: { monthly_credits: 20000, credits_per_run: 2000, concurrent_runs: 3 }, included_credits: 5000, overage_policy: "allow_overage" });
      const { ws, user } = await makeWorkspace("normal", plan, reservation * 4);
      const { project } = await createProjectForUser(svc, user, { workspace_id: ws.id, name: "Normal" });
      const runId = `r_${stamp}_norm`;
      const { operation } = await runOp(ws, runId, { project_id: project.id });
      const held = await deriveBalance(svc, ws.id);
      const again = await runOp(ws, runId, { project_id: project.id });
      const settled = await settleUsage(svc, { workspace_id: ws.id, project_id: project.id, run_id: runId, operation_type: "ai_run", model: MODEL, usage: USAGE, idempotency_key: `run:${runId}`, status: "completed" });
      const after = await deriveBalance(svc, ws.id);
      const replay = await settleUsage(svc, { workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model: MODEL, usage: USAGE, idempotency_key: `run:${runId}`, status: "completed" });
      check("15. existing operations unchanged: reserve → re-attach → settle → release → idempotent replay",
        held.reserved === operation.credits_reserved && again.reattached && settled.credits_charged > 0 && settled.credits_charged < operation.credits_reserved &&
        after.reserved === 0 && Math.abs(after.balance - (held.balance - settled.credits_charged)) < 1e-6 && replay.duplicate && (await verifyBalanceIntegrity(svc, ws.id)).ok,
        `reserved ${operation.credits_reserved}, charged ${settled.credits_charged}, balance ${after.balance}`);
    }

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const wsId of created.workspaces) {
      const projs = await svc.entities.Project.filter({ workspace_id: wsId }, "-created_date", 100).catch(() => []);
      for (const p of projs) {
        for (const name of ["ProjectFile", "ProjectVersion", "CustomDomain"]) {
          for (const r of await svc.entities[name].filter({ project_id: p.id }, "-created_date", 200).catch(() => [])) await svc.entities[name].delete(r.id).catch(() => {});
        }
      }
      await cleanupWorkspace(svc, wsId, ["Project", "WorkspaceMember", "CustomDomain", "AIOperation", "CreditLedgerEntry", "Subscription", "AuditLog"]);
    }
    for (const id of created.plans) await svc.entities.BillingPlan.delete(id).catch(() => {});
  }
}