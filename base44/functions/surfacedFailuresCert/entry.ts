// In-memory regression for R-9/R-10 (PROVISIONAL mapping: PA-26 rollback, PA-51 context).
// No database, no provider calls.
import { rollbackCommit, recoverPendingCommits } from "../../shared/commitJournal.ts";
import { otherConversationsBlock, OTHER_CONVERSATIONS_UNAVAILABLE } from "../../shared/appAgentRuntime.ts";

export const config = { method: "POST" };

function stub(failOn = null, journalStatus = "applying") {
  const journal = { id: "j1", project_id: "p1", run_id: "r1", status: journalStatus, base_version_number: 2, previous_snapshot: { files: [], entities: [] }, heartbeat_at: new Date(0).toISOString(), created_date: new Date(0).toISOString() };
  const boom = (k) => { if (failOn === k) throw new Error("injected"); };
  const empty = async () => ({ items: [] });
  const svc = { entities: {
    ProjectFile: { filter: empty }, AppEntity: { filter: empty }, ProjectSecret: { filter: empty },
    ProjectVersion: {
      filter: async () => { boom("versions_read"); return { items: [{ id: "v9" }] }; },
      delete: async () => { boom("version_delete"); },
    },
    Project: { update: async () => { boom("version_count"); }, get: async () => ({ id: "p1" }) },
    CommitJournal: {
      update: async (_id, d) => { Object.assign(journal, d); return { ...journal }; },
      get: async () => ({ ...journal }),
      filter: async (q) => ({ items: journal.status === q.status ? [{ ...journal }] : [] }),
    },
  } };
  return { svc: { asServiceRole: svc, entities: svc.entities }, journal };
}

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail).slice(0, 240) });

  for (const [failOn, step] of [["versions_read", "orphan_versions_read"], ["version_delete", "orphan_version_delete"], ["version_count", "version_count"]]) {
    const { svc, journal } = stub(failOn);
    const out = await rollbackCommit(svc, journal, "original error");
    add(`${failOn} failure: rollback not reported as done`, out.rolled_back === false && out.partial === true && out.undo_failures.includes(step), out);
    add(`${failOn} failure: journal left recoverable ('applying') with the original error`, journal.status === "applying" && /rollback incomplete/.test(journal.error) && /original error/.test(journal.error), { s: journal.status, e: journal.error });
  }
  const appliedPartial = stub("version_count", "applied");
  await rollbackCommit(appliedPartial.svc, appliedPartial.journal, "x");
  add("a partially undone 'applied' journal is never left to be rolled forward", appliedPartial.journal.status === "applying", appliedPartial.journal.status);

  const ok = stub(null);
  const good = await rollbackCommit(ok.svc, ok.journal, "x");
  add("all undo steps succeed: rolled back", good.rolled_back === true && ok.journal.status === "rolled_back", { good: good.rolled_back, s: ok.journal.status });

  const sweep = stub("version_delete");
  const swept = await recoverPendingCommits(sweep.svc, { staleAfterMs: 1 });
  add("recovery sweep reports a partial rollback as FAILED, not ROLLED_BACK", swept.recovered[0]?.action === "FAILED" && /rollback incomplete/.test(swept.recovered[0]?.error || ""), swept.recovered);

  const failing = { entities: { AppRecord: { filter: async () => { throw new Error("injected"); } } } };
  const block = await otherConversationsBlock(failing, { id: "p1" }, { name: "a" }, { id: "u1" }, "c0", []);
  add("unreadable conversation list is reported as unavailable, not empty", block === OTHER_CONVERSATIONS_UNAVAILABLE && block !== "", block);
  const none = { entities: { AppRecord: { filter: async () => [] } } };
  add("a genuinely empty list still yields no block", (await otherConversationsBlock(none, { id: "p1" }, { name: "a" }, { id: "u1" }, "c0", [])) === "", "");

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});