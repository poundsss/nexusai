// P-16C1 — model selection parity: targeted verification.
//
// Exercises the documented behaviors against real scratch rows:
//   1. manual model selection requires a Builder plan or higher (server-side, at enqueue);
//   2. below Builder, Auto (no modelId) still enqueues;
//   3. Discuss ignores a model preference (Build preserves it);
//   4. a Discuss message settles at the documented FIXED 0.3 credits, idempotently,
//      while Build keeps token-derived pricing;
//   5. the selection gate resolution matches the canonical subscription state.
// No other cluster is touched; fixtures are created and removed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { makeChecks } from "../../shared/testChecklist.ts";
import { enqueueRun } from "../../shared/runEnqueue.ts";
import { resolveModelSelection, MODEL_SELECTION_MIN_TIER_RANK } from "../../shared/subscriptions.ts";
import { preferredModelIdFor } from "../../shared/modelGateway.ts";
import { settleUsage } from "../../shared/aiOperations.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const { checks, bad, expect } = makeChecks();
  const cleanup = [];
  const delAll = async (entity, filter) => {
    for (const r of await svc.entities[entity].filter(filter, "created_date", 500).catch(() => [])) {
      await svc.entities[entity].delete(r.id).catch(() => {});
    }
  };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `MSL16C1 ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    cleanup.push(() => delAll("CreditLedgerEntry", { workspace_id: ws.id }));
    cleanup.push(() => delAll("AIOperation", { workspace_id: ws.id }));
    cleanup.push(() => delAll("AIRun", { project_id: ws.id })); // project_id-filtered below
    cleanup.push(() => delAll("Message", { project_id: ws.id }));
    cleanup.push(() => delAll("Conversation", { project_id: ws.id }));
    cleanup.push(() => delAll("Subscription", { workspace_id: ws.id }));
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "parity", status: "ready" });
    cleanup.push(() => delAll("AIRun", { project_id: project.id }));
    cleanup.push(() => delAll("Message", { project_id: project.id }));
    cleanup.push(() => delAll("Conversation", { project_id: project.id }));
    cleanup.push(() => svc.entities.Project.delete(project.id));
    cleanup.push(() => svc.entities.Workspace.delete(ws.id));

    // --- 1. Builder+ selection gate ------------------------------------------------
    const selFree = await resolveModelSelection(svc, { workspace_id: ws.id });
    expect("1a. a plan-less workspace resolves to the free plan and CANNOT select a model", selFree.ok === false && selFree.tier_rank === 0, JSON.stringify(selFree));
    let refused = null;
    try { await enqueueRun(svc, { project, prompt: "gate probe", modelId: "claude-sonnet-5" }); } catch (e) { refused = e; }
    expect("1b. enqueue WITH a model on a free plan is refused server-side", refused?.message?.includes("MODEL_SELECTION_PLAN_REQUIRED") || refused?.code === "MODEL_SELECTION_PLAN_REQUIRED" || String(refused?.message || "").includes("Builder plan"), String(refused?.message || refused).slice(0, 120));
    const autoRun = await enqueueRun(svc, { project, prompt: "auto probe" });
    expect("1c. enqueue with AUTO (no model) on a free plan still works", !!autoRun.run_id, autoRun.run_id);
    // --- 2. Builder tier unlocks selection ------------------------------------------
    const sub = await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "builder_monthly", status: "active" });
    cleanup.push(() => svc.entities.Subscription.delete(sub.id));
    const selBuilder = await resolveModelSelection(svc, { workspace_id: ws.id });
    expect("2a. an active Builder subscription resolves to tier 6 and CAN select a model", selBuilder.ok === true && selBuilder.tier_rank === MODEL_SELECTION_MIN_TIER_RANK, JSON.stringify(selBuilder));
    const pickedRun = await enqueueRun(svc, { project, prompt: "picked probe", modelId: "claude-sonnet-5" });
    expect("2b. enqueue WITH a model on a Builder plan is accepted", !!pickedRun.run_id, pickedRun.run_id);

    // --- 3. Discuss ignores the preference, Build preserves it -----------------------
    expect("3a. Discuss drops a manual model preference", preferredModelIdFor({ mode: "discuss", preferred_model_id: "claude-sonnet-5" }) === null, "");
    expect("3b. Build preserves the preference", preferredModelIdFor({ mode: "default", preferred_model_id: "claude-sonnet-5" }) === "claude-sonnet-5", "");
    expect("3c. Discuss with no preference stays null", preferredModelIdFor({ mode: "discuss" }) === null, "");

    // --- 4. Discuss = FIXED 0.3 credits; Build keeps token-derived pricing ------------
    const baseOp = { workspace_id: ws.id, user_id: caller.id, project_id: project.id, operation_type: "ai_run", credit_type: "message", provider: "anthropic", gateway_provider: "base44-core", model_id: "claude-sonnet-5", streaming: false, status: "running", usage_source: "provider", credits_reserved: 0, started_at: new Date().toISOString() };
    const usage = { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 1500 };
    const opDiscuss = await svc.entities.AIOperation.create({ ...baseOp, idempotency_key: `mst:d${Date.now()}` });
    const settledDiscuss = await settleUsage(svc, {
      workspace_id: ws.id, user_id: caller.id, project_id: project.id, operation_type: "ai_run",
      model: { model_id: "claude-sonnet-5", provider: "anthropic", upstream_provider: "anthropic" },
      usage, idempotency_key: opDiscuss.idempotency_key, status: "completed", usage_source: "provider", fixed_credits: 0.3,
    });
    expect("4a. a Discuss message settles at EXACTLY the documented 0.3 credits", settledDiscuss.credits_charged === 0.3, String(settledDiscuss.credits_charged));
    const replayed = await settleUsage(svc, {
      workspace_id: ws.id, user_id: caller.id, project_id: project.id, operation_type: "ai_run",
      model: { model_id: "claude-sonnet-5", provider: "anthropic", upstream_provider: "anthropic" },
      usage, idempotency_key: opDiscuss.idempotency_key, status: "completed", usage_source: "provider", fixed_credits: 0.3,
    });
    expect("4b. the settle replay is idempotent (no second charge)", replayed.duplicate === true && replayed.credits_charged === 0.3, `${replayed.duplicate}/${replayed.credits_charged}`);
    const ledgerRows = await svc.entities.CreditLedgerEntry.filter({ workspace_id: ws.id, idempotency_key: `charge:${opDiscuss.idempotency_key}` }, "created_date", 10);
    expect("4c. exactly ONE ledger charge entry exists for the Discuss settlement", ledgerRows.length === 1 && Number(ledgerRows[0]?.amount) === -0.3, JSON.stringify(ledgerRows.map((r) => r.amount)));

    const opBuild = await svc.entities.AIOperation.create({ ...baseOp, idempotency_key: `mst:b${Date.now()}` });
    const settledBuild = await settleUsage(svc, {
      workspace_id: ws.id, user_id: caller.id, project_id: project.id, operation_type: "ai_run",
      model: { model_id: "claude-sonnet-5", provider: "anthropic", upstream_provider: "anthropic" },
      usage, idempotency_key: opBuild.idempotency_key, status: "completed", usage_source: "provider",
    });
    expect("4d. Build keeps token-derived pricing (unchanged, ceil-rounded charge)", settledBuild.credits_charged === 2, String(settledBuild.credits_charged));

    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } catch (e) {
    bad("harness", `${e.name}: ${e.message}`);
    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }
}