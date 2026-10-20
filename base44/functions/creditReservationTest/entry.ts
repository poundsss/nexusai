// End-to-end verification of the credit reservation lifecycle and the automatic
// abandoned-operation recovery sweep.
//
// This drives the REAL machinery — beginOperation → ledger reservation → settleUsage →
// finalizeOperation → ledger charge/release, and the actual registered maintenance handler.
// It never calls a model provider: the run pipeline's own settlement path is exercised with
// the same idempotency keys (`run:<id>`) the pipeline uses, so what is proven here is exactly
// what a Builder run does with credits.
//
// Every test runs in a throwaway workspace and cleans up after itself.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { beginOperation, settleUsage, finalizeOperation, findOperation } from "../../shared/aiOperations.ts";
import { recordEvent, deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { estimateMaxCharge, loadCreditPolicy } from "../../shared/economics.ts";
import { MAINTENANCE_HANDLERS, MAINTENANCE_SCHEDULE } from "../../shared/jobHandlers.ts";

const MODEL_ID = "gemini-3-flash";
const MODEL = { model_id: MODEL_ID, id: MODEL_ID, provider: "base44-core", upstream_provider: "google", name: "gemini_3_flash" };
const RUN_ESTIMATE = { max_input_tokens: 60000, max_output_tokens: 12000 };
const USAGE = { input_tokens: 24000, output_tokens: 3000 };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const results = [];
  const created = { workspaces: [], operations: [] };
  const t = (name, ok, detail) => { results.push({ test: name, ok: !!ok, detail }); return ok; };

  const newWorkspace = async (credits, label) => {
    const ws = await db.entities.Workspace.create({ name: `credit-test ${label} ${Date.now()}`, owner_id: "credit_reservation_test", status: "active" });
    created.workspaces.push(ws.id);
    await recordEvent(db, {
      workspace_id: ws.id, event_type: "promotional", amount: credits,
      idempotency_key: `test-grant:${ws.id}`, reason: "Test credit grant",
    });
    return ws;
  };
  const track = (op) => { if (op?.id) created.operations.push(op.id); return op; };

  try {
    const policy = await loadCreditPolicy(db, null);
    const reservationSize = estimateMaxCharge({ model_id: MODEL_ID, ...RUN_ESTIMATE, operation_type: "ai_run", policy }).credits;

    // --- 1. Successful run: real usage charged, unused reservation released ----
    {
      const ws = await newWorkspace(reservationSize * 4, "success");
      const runId = `run_ok_${Date.now()}`;
      const key = `run:${runId}`;

      const { operation } = await beginOperation(db, {
        workspace_id: ws.id, run_id: runId, project_id: null, operation_type: "ai_run",
        model_id: MODEL_ID, gateway_provider: "base44-core", idempotency_key: key, estimate: RUN_ESTIMATE,
      });
      track(operation);
      const held = await deriveBalance(db, ws.id);
      t("success: reservation held before execution",
        held.reserved === operation.credits_reserved && operation.credits_reserved > 0 && held.available === held.balance - held.reserved,
        { reserved: held.reserved, available: held.available, balance: held.balance });

      // Re-driving the same phase must NOT reserve twice.
      const again = await beginOperation(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model_id: MODEL_ID,
        idempotency_key: key, estimate: RUN_ESTIMATE,
      });
      const afterRetry = await deriveBalance(db, ws.id);
      t("success: re-driven phase re-attaches instead of double-reserving",
        again.reattached === true && again.operation.id === operation.id && afterRetry.reserved === held.reserved,
        { reserved: afterRetry.reserved });

      const settled = await settleUsage(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model: MODEL,
        usage: USAGE, usage_source: "estimated", idempotency_key: key, status: "completed",
      });
      const after = await deriveBalance(db, ws.id);
      t("success: actual usage charged and unused reservation released",
        settled.credits_charged > 0 && settled.credits_charged < operation.credits_reserved &&
        after.reserved === 0 && Math.abs(after.balance - (held.balance - settled.credits_charged)) < 1e-6,
        { reserved_credits: operation.credits_reserved, credits_charged: settled.credits_charged, released: operation.credits_reserved, balance: after.balance, available: after.available });

      const replay = await settleUsage(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model: MODEL,
        usage: USAGE, idempotency_key: key, status: "completed",
      });
      const afterReplay = await deriveBalance(db, ws.id);
      t("success: replayed settlement charges nothing (idempotency preserved)",
        replay.duplicate === true && afterReplay.balance === after.balance && afterReplay.reserved === 0,
        { balance: afterReplay.balance });

      const integrity = await verifyBalanceIntegrity(db, ws.id);
      t("success: cached projection matches derived ledger", integrity.ok, integrity);
    }

    // --- 2. Failed run: reservation released, nothing charged -----------------
    {
      const ws = await newWorkspace(reservationSize * 4, "failure");
      const runId = `run_fail_${Date.now()}`;
      const key = `run:${runId}`;
      const { operation } = await beginOperation(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model_id: MODEL_ID,
        idempotency_key: key, estimate: RUN_ESTIMATE,
      });
      track(operation);
      const held = await deriveBalance(db, ws.id);

      // The pipeline's failRun path settles WITHOUT a model — the reservation must still go back.
      // A run that recorded NO provider usage settles failed and uncharged. (A failed run that DID
      // deliver usage is billed for it by policy — that path is covered by the abandoned-recovery
      // scenario below, which settles real persisted usage.)
      const failed = await settleUsage(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model: null,
        usage: {}, idempotency_key: key, status: "failed",
      });
      const after = await deriveBalance(db, ws.id);
      const op = await db.entities.AIOperation.get(operation.id);
      t("failure: reservation released and nothing charged",
        held.reserved > 0 && after.reserved === 0 && failed.credits_charged === 0 &&
        after.balance === held.balance && after.available === held.balance && op.status === "failed" && !!op.finalized_at,
        { held: held.reserved, after_reserved: after.reserved, balance: after.balance, operation_status: op.status });
    }

    // --- 3. Discarded run (version conflict): charge refunded -----------------
    {
      const ws = await newWorkspace(reservationSize * 4, "refund");
      const runId = `run_conflict_${Date.now()}`;
      const key = `run:${runId}`;
      const { operation } = await beginOperation(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model_id: MODEL_ID,
        idempotency_key: key, estimate: RUN_ESTIMATE,
      });
      track(operation);
      const before = await deriveBalance(db, ws.id);
      const settled = await settleUsage(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model: MODEL,
        usage: USAGE, idempotency_key: key, status: "failed",
        refundReason: "Refund: AI run discarded due to version conflict",
      });
      const after = await deriveBalance(db, ws.id);
      const op = await db.entities.AIOperation.get(operation.id);
      t("discarded run: reservation released and user left whole",
        after.reserved === 0 && after.balance === before.balance && (op.credits_charged || 0) - (op.credits_refunded || 0) === 0,
        { balance_before: before.balance, balance_after: after.balance, charged: op.credits_charged, refunded: op.credits_refunded, settled: settled.credits_charged });
    }

    // --- 4. Two concurrent runs cannot overspend ------------------------------
    {
      // Enough for exactly one worst-case run, plus a sliver.
      const ws = await newWorkspace(reservationSize + 1, "concurrency");
      const keyA = `run:run_conc_a_${Date.now()}`;
      const keyB = `run:run_conc_b_${Date.now()}`;
      const first = await beginOperation(db, {
        workspace_id: ws.id, run_id: "conc_a", operation_type: "ai_run", model_id: MODEL_ID,
        idempotency_key: keyA, estimate: RUN_ESTIMATE,
      });
      track(first.operation);

      let refused = null;
      try {
        const second = await beginOperation(db, {
          workspace_id: ws.id, run_id: "conc_b", operation_type: "ai_run", model_id: MODEL_ID,
          idempotency_key: keyB, estimate: RUN_ESTIMATE,
        });
        track(second.operation);
      } catch (e) {
        refused = { code: e.code, message: e.message };
      }
      const state = await deriveBalance(db, ws.id);
      t("concurrency: second run refused before any provider call",
        !!refused && ["INSUFFICIENT_CREDITS", "BUDGET_EXCEEDED"].includes(refused.code),
        refused || "second run was NOT refused");
      t("concurrency: available credits never go negative",
        state.available >= 0 && state.reserved === first.operation.credits_reserved,
        { balance: state.balance, reserved: state.reserved, available: state.available });

      // Once the first run settles, the freed reservation makes the balance usable again.
      await settleUsage(db, {
        workspace_id: ws.id, run_id: "conc_a", operation_type: "ai_run", model: MODEL,
        usage: USAGE, idempotency_key: keyA, status: "completed",
      });
      const freed = await deriveBalance(db, ws.id);
      t("concurrency: settlement frees the hold for the next run",
        freed.reserved === 0 && freed.available === freed.balance && freed.balance > 0,
        { balance: freed.balance, available: freed.available });
    }

    // --- 5. Worker-abandoned operation is reconciled automatically ------------
    {
      t("recovery: sweep is registered on the maintenance schedule",
        !!MAINTENANCE_HANDLERS["billing.reconcile_operations"] &&
        MAINTENANCE_SCHEDULE.some((s) => s.job_type === "billing.reconcile_operations" && s.queue === "maintenance"),
        MAINTENANCE_SCHEDULE.map((s) => s.job_type));

      const ws = await newWorkspace(reservationSize * 4, "abandoned");
      const runId = `run_abandoned_${Date.now()}`;
      const key = `run:${runId}`;
      const { operation } = await beginOperation(db, {
        workspace_id: ws.id, run_id: runId, operation_type: "ai_run", model_id: MODEL_ID,
        idempotency_key: key, estimate: RUN_ESTIMATE,
      });
      track(operation);
      // The worker died after the provider delivered: usage is on the operation, no settlement,
      // reservation still held, and the record is older than the sweep's cutoff.
      await db.entities.AIOperation.update(operation.id, {
        input_tokens: USAGE.input_tokens, output_tokens: USAGE.output_tokens,
        total_tokens: USAGE.input_tokens + USAGE.output_tokens,
        started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });
      const stranded = await deriveBalance(db, ws.id);

      // The real registered handler, exactly as the queue worker invokes it.
      const swept = await MAINTENANCE_HANDLERS["billing.reconcile_operations"](
        { id: "test_job", payload: { older_than_ms: 15 * 60 * 1000 } },
        { base44: db, heartbeat: async () => {} },
      );

      const op = await db.entities.AIOperation.get(operation.id);
      const after = await deriveBalance(db, ws.id);
      t("recovery: abandoned operation settled from its real usage",
        !!op.finalized_at && op.status === "completed" && (op.credits_charged || 0) > 0,
        { status: op.status, credits_charged: op.credits_charged, finalized_at: op.finalized_at });
      t("recovery: stranded reservation released",
        stranded.reserved > 0 && after.reserved === 0 && Math.abs(after.balance - (stranded.balance - (op.credits_charged || 0))) < 1e-6,
        { reserved_before: stranded.reserved, reserved_after: after.reserved, balance: after.balance });
      t("recovery: sweep reports what it settled",
        swept.workspaces_scanned > 0 && swept.reconciled.some((r) => r.workspace_id === ws.id),
        { workspaces_scanned: swept.workspaces_scanned, reconciled_workspaces: swept.reconciled.length });

      // The manual admin path is the same function: a second sweep is a no-op.
      const twice = await MAINTENANCE_HANDLERS["billing.reconcile_operations"](
        { id: "test_job_2", payload: { older_than_ms: 15 * 60 * 1000 } },
        { base44: db, heartbeat: async () => {} },
      );
      const afterTwice = await deriveBalance(db, ws.id);
      t("recovery: repeated sweep charges nothing again",
        afterTwice.balance === after.balance && !twice.reconciled.some((r) => r.workspace_id === ws.id),
        { balance: afterTwice.balance });
    }

    // Nothing open must be left holding credits for a finalized operation.
    for (const opId of created.operations) {
      const op = await db.entities.AIOperation.get(opId).catch(() => null);
      if (op && !op.finalized_at && op.status === "running") {
        await finalizeOperation(db, { operation_id: op.id, status: "failed", error: "test cleanup" }).catch(() => {});
      }
    }

    const passed = results.filter((r) => r.ok).length;
    return Response.json({ ok: passed === results.length, passed, total: results.length, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, code: error.code || null, results }, { status: 500 });
  } finally {
    // Teardown: the test's own ledger entries, operations and workspaces.
    for (const opId of created.operations) await db.entities.AIOperation.delete(opId).catch(() => {});
    for (const wsId of created.workspaces) {
      const entries = await db.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "created_date", 200).catch(() => []);
      for (const e of entries) await db.entities.CreditLedgerEntry.delete(e.id).catch(() => {});
      const ops = await db.entities.AIOperation.filter({ workspace_id: wsId }, "created_date", 100).catch(() => []);
      for (const o of ops) await db.entities.AIOperation.delete(o.id).catch(() => {});
      await db.entities.Workspace.delete(wsId).catch(() => {});
    }
  }
}