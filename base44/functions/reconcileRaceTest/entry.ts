// P-7 regression: the abandoned-operation sweep must never settle an operation whose run still
// has a live worker behind it — ownership is confirmed by the run's OWN existing markers (a valid
// phase lease OR a fresh heartbeat) — while a genuinely dead owner's operation is still recovered
// with the same abandon rule the reaper applies (lease expired AND heartbeat stale).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { reconcileAbandonedOperations } from "../../shared/aiOperations.ts";
import { recordEvent, deriveBalance, reserve } from "../../shared/ledger.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const results = [];
  const created = { workspaces: [], runs: [], operations: [] };
  const t = (name, ok, detail) => { results.push({ test: name, ok: !!ok, detail }); return ok; };
  const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  try {
    const newWorkspace = async (label) => {
      const ws = await db.entities.Workspace.create({ name: `race ${label} ${Date.now()}`, owner_id: "race_test", status: "active" });
      created.workspaces.push(ws.id);
      await recordEvent(db, { workspace_id: ws.id, event_type: "promotional", amount: 5000, idempotency_key: `grant:${ws.id}`, reason: "test grant" });
      return ws;
    };
    const makeOperation = async (ws, runId) => {
      const op = await db.entities.AIOperation.create({
        workspace_id: ws.id, run_id: runId, user_id: null, operation_type: "ai_run",
        status: "running", credits_reserved: 200, idempotency_key: `run:${runId}`, started_at: OLD,
      });
      created.operations.push(op.id);
      await reserve(db, { workspace_id: ws.id, operation_id: op.id, credits: 200, idempotency_key: `reserve:run:${runId}`, reason: "test reservation" });
      return op;
    };

    // --- 1. Live worker: stale heartbeat but a VALID phase lease → the sweep must NOT settle ---
    {
      const ws = await newWorkspace("lease-live");
      const run = await db.entities.AIRun.create({
        project_id: `race_${Date.now()}`, workspace_id: ws.id, goal: "", mode: "default",
        status: "EXECUTING", phase: "generate", heartbeat_at: OLD,
        phase_lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      created.runs.push(run.id);
      const op = await makeOperation(ws, run.id);
      const held = await deriveBalance(db, ws.id);

      const swept = await reconcileAbandonedOperations(db, { workspace_id: ws.id, older_than_ms: 15 * 60 * 1000 });
      const after = await deriveBalance(db, ws.id);
      const opAfter = await db.entities.AIOperation.get(op.id);
      t("valid lease: sweep leaves the live operation alone",
        !swept.some((r) => r.operation_id === op.id) && opAfter.status === "running" && !opAfter.finalized_at,
        { status: opAfter.status, settled: swept.some((r) => r.operation_id === op.id) });
      t("valid lease: reservation stays held for the live worker",
        held.reserved === 200 && after.reserved === 200 && Math.abs(after.balance - 5000) < 1e-6,
        { reserved_after: after.reserved });
    }

    // --- 2. Dead worker: lease expired AND heartbeat stale → recovered exactly as before -------
    {
      const ws = await newWorkspace("lease-dead");
      const run = await db.entities.AIRun.create({
        project_id: `race_${Date.now()}`, workspace_id: ws.id, goal: "", mode: "default",
        status: "EXECUTING", phase: "generate", heartbeat_at: OLD,
        phase_lease_expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });
      created.runs.push(run.id);
      const op = await makeOperation(ws, run.id);
      await db.entities.AIOperation.update(op.id, { input_tokens: 4000, output_tokens: 900, total_tokens: 4900 });
      const held = await deriveBalance(db, ws.id);

      const swept = await reconcileAbandonedOperations(db, { workspace_id: ws.id, older_than_ms: 15 * 60 * 1000 });
      const after = await deriveBalance(db, ws.id);
      const opAfter = await db.entities.AIOperation.get(op.id);
      t("dead worker: sweep settles the abandoned operation",
        swept.some((r) => r.operation_id === op.id) && !!opAfter.finalized_at,
        { status: opAfter.status, finalized_at: opAfter.finalized_at });
      t("dead worker: stranded hold released",
        held.reserved === 200 && after.reserved === 0,
        { reserved_after: after.reserved });
    }

    // --- 3. Fresh heartbeat (no lease) → still protected, unchanged behavior -------------------
    {
      const ws = await newWorkspace("heartbeat-live");
      const run = await db.entities.AIRun.create({
        project_id: `race_${Date.now()}`, workspace_id: ws.id, goal: "", mode: "default",
        status: "EXECUTING", phase: "generate", heartbeat_at: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      created.runs.push(run.id);
      const op = await makeOperation(ws, run.id);
      const swept = await reconcileAbandonedOperations(db, { workspace_id: ws.id, older_than_ms: 15 * 60 * 1000 });
      const opAfter = await db.entities.AIOperation.get(op.id);
      t("fresh heartbeat: sweep still protects the live operation",
        !swept.some((r) => r.operation_id === op.id) && opAfter.status === "running",
        { status: opAfter.status });
    }

    const passed = results.filter((r) => r.ok).length;
    return Response.json({ ok: passed === results.length, passed, total: results.length, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, code: error.code || null, results }, { status: 500 });
  } finally {
    for (const opId of created.operations) await db.entities.AIOperation.delete(opId).catch(() => {});
    for (const runId of created.runs) await db.entities.AIRun.delete(runId).catch(() => {});
    for (const wsId of created.workspaces) {
      const entries = await db.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "created_date", 200).catch(() => []);
      for (const e of entries) await db.entities.CreditLedgerEntry.delete(e.id).catch(() => {});
      const events = await db.entities.UsageEvent.filter({ workspace_id: wsId }, "created_date", 100).catch(() => []);
      for (const e of events) await db.entities.UsageEvent.delete(e.id).catch(() => {});
      const ops = await db.entities.AIOperation.filter({ workspace_id: wsId }, "created_date", 100).catch(() => []);
      for (const o of ops) await db.entities.AIOperation.delete(o.id).catch(() => {});
      await db.entities.Workspace.delete(wsId).catch(() => {});
    }
  }
}