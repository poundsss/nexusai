// Stranded-hold regression: a settlement whose usage CANNOT be priced (missing or unknown
// model_id, e.g. a model removed from the catalog) must fail CLOSED on charging while still
// releasing the reservation and finalizing the operation.
//
// Before the fix, the pricing throw propagated out of finalizeOperation BEFORE the release path:
//   * cancelRun swallowed it, so the run went CANCELLED with its hold stranded forever;
//   * the abandoned-operation sweep re-threw on every pass, dead-lettering the maintenance job
//     while the hold stayed active.
// This drives the REAL machinery (settleUsage → finalizeOperation → ledger release, and the real
// sweep) with an operation whose usage exists but has no priceable model.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { settleUsage, reconcileAbandonedOperations } from "../../shared/aiOperations.ts";
import { recordEvent, deriveBalance, reserve } from "../../shared/ledger.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const results = [];
  const created = { workspaces: [], operations: [] };
  const t = (name, ok, detail) => { results.push({ test: name, ok: !!ok, detail }); return ok; };

  try {
    const newWorkspace = async (label) => {
      const ws = await db.entities.Workspace.create({ name: `pricing-fail ${label} ${Date.now()}`, owner_id: "pricing_failure_test", status: "active" });
      created.workspaces.push(ws.id);
      await recordEvent(db, {
        workspace_id: ws.id, event_type: "promotional", amount: 5000,
        idempotency_key: `test-grant:${ws.id}`, reason: "Test credit grant",
      });
      return ws;
    };
    // An operation with REAL usage but NO priceable model (model_id deliberately absent).
    const makeOperation = async (ws, key, startedAt) => {
      const op = await db.entities.AIOperation.create({
        workspace_id: ws.id, run_id: null, user_id: null, operation_type: "ai_run",
        status: "running", credits_reserved: 200, idempotency_key: key, started_at: startedAt,
      });
      created.operations.push(op.id);
      await reserve(db, { workspace_id: ws.id, operation_id: op.id, credits: 200, idempotency_key: `reserve:${key}`, reason: "test reservation" });
      return op;
    };
    const USAGE = { input_tokens: 4000, output_tokens: 900 };

    // --- 1. settleUsage on unpriceable usage: no throw, nothing charged, hold released ------
    {
      const ws = await newWorkspace("settle");
      const key = `run:pf_settle_${Date.now()}`;
      const op = await makeOperation(ws, key, new Date().toISOString());
      const held = await deriveBalance(db, ws.id);

      let res = null;
      let threw = null;
      try {
        res = await settleUsage(db, {
          workspace_id: ws.id, run_id: null, operation_type: "ai_run", model: null,
          usage: USAGE, idempotency_key: key, status: "completed",
        });
      } catch (e) { threw = e.message; }
      const after = await deriveBalance(db, ws.id);
      const opAfter = await db.entities.AIOperation.get(op.id);

      t("settle does not throw on unpriceable usage", !threw && !!res, threw || "settled");
      t("settle charges nothing when pricing fails (fail closed)",
        !threw && (res?.credits_charged || 0) === 0 && Math.abs(after.balance - held.balance) < 1e-6,
        { balance_before: held.balance, balance_after: after.balance });
      t("settle releases the hold that pricing stranded",
        held.reserved === 200 && after.reserved === 0 && Math.abs(after.available - 5000) < 1e-6,
        { reserved_before: held.reserved, reserved_after: after.reserved });
      t("operation finalized failed with the pricing reason recorded",
        opAfter.status === "failed" && !!opAfter.finalized_at && /pricing failed/i.test(opAfter.error || ""),
        { status: opAfter.status, error: opAfter.error });

      const replay = await settleUsage(db, {
        workspace_id: ws.id, run_id: null, operation_type: "ai_run", model: null,
        usage: USAGE, idempotency_key: key, status: "completed",
      });
      const afterReplay = await deriveBalance(db, ws.id);
      t("replayed settle is an idempotent no-op",
        replay.duplicate === true && Math.abs(afterReplay.balance - after.balance) < 1e-6 && afterReplay.reserved === 0,
        { balance: afterReplay.balance, reserved: afterReplay.reserved });
    }

    // --- 2. the sweep finalizes an abandoned unpriceable operation instead of throwing -------
    {
      const ws = await newWorkspace("sweep");
      const key = `run:pf_sweep_${Date.now()}`;
      const op = await makeOperation(ws, key, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
      // Usage recorded on the operation itself, exactly like a worker that died mid-run.
      await db.entities.AIOperation.update(op.id, { input_tokens: USAGE.input_tokens, output_tokens: USAGE.output_tokens, total_tokens: USAGE.input_tokens + USAGE.output_tokens });
      const held = await deriveBalance(db, ws.id);

      const swept = await reconcileAbandonedOperations(db, { workspace_id: ws.id, older_than_ms: 60 * 60 * 1000 });
      const after = await deriveBalance(db, ws.id);
      const opAfter = await db.entities.AIOperation.get(op.id);
      const entry = (swept || []).find((r) => r.operation_id === op.id);

      t("sweep completes without throwing on unpriceable usage", !!entry, { entry: entry || null });
      t("sweep releases the abandoned hold",
        held.reserved === 200 && after.reserved === 0 && Math.abs(after.balance - 5000) < 1e-6,
        { reserved_after: after.reserved, balance: after.balance });
      t("swept operation finalized failed, uncharged",
        opAfter.status === "failed" && !!opAfter.finalized_at && (opAfter.credits_charged || 0) === 0,
        { status: opAfter.status, charged: opAfter.credits_charged });
    }

    const passed = results.filter((r) => r.ok).length;
    return Response.json({ ok: passed === results.length, passed, total: results.length, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, code: error.code || null, results }, { status: 500 });
  } finally {
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