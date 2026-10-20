// Best-effort post-mutation Architecture reconciliation wrapper.
//
// A THIN, NON-MUTATING wrapper around the EXISTING reconcileArchitecture() contract. Every
// version-producing mutation path calls this AFTER its own success; a reconciliation failure
// is swallowed so the mutation that already landed is NEVER rolled back or failed by it.
//
// This wrapper changes NOTHING about the contract it delegates to:
//   • reconcileArchitecture re-resolves project.write through loadAuthorizedProject, so a caller
//     that lost the capability reconciles nothing (no-op) — never escalates. No service-role bypass.
//   • Idempotency is unchanged: the fingerprint check inside reconcileArchitecture means
//     unchanged authoritative state reuses the existing finalized version — no duplicate
//     version/nodes/edges. A second call after the same mutation is a no-op.
//   • Concurrency is unchanged: version allocation and SUPERSEDED resolution stay as-is.
//   • No new source of truth: this module stores nothing and exposes only a status summary.
//
// `user` MUST be the authenticated user whose mutation just succeeded (the same user the
// mutation boundary authorized for project.write). A path that has no such user passes null
// and the call no-ops — it never invents a service-role identity.
import { reconcileArchitecture } from "./architecture.ts";
import { log } from "./observability.ts";

/**
 * Reconcile Architecture after a successful mutation. Never throws.
 *
 * @returns {{ ok: boolean, created?: boolean, version?: number|null, reason?: string|null }}
 *   ok=true if reconcileArchitecture ran (created or reused); ok=false with a reason if it was
 *   skipped or failed. Callers may ignore the return value entirely.
 */
export async function reconcileArchitectureAfterMutation(base44, user, { project_id, trace_id = null, run_id = null } = {}) {
  try {
    if (!user?.id || !project_id) return { ok: false, reason: "missing_context" };
    const out = await reconcileArchitecture(base44, user, { project_id, trace_id, run_id });
    return {
      ok: true,
      created: !!out.created,
      version: out.architecture?.version ?? null,
      reason: out.reason || null,
    };
  } catch (e) {
    // The mutation already succeeded. A reconciliation failure is diagnostic only: logged and
    // dropped, so the caller's commit/restore/relation-write is never affected by it.
    log("warn", "architecture.post_mutation_reconcile_failed", { project_id: project_id || null, run_id: run_id || null, error: e?.message || String(e) });
    return { ok: false, reason: "reconcile_error", error: e?.message || String(e) };
  }
}