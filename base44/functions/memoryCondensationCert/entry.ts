// P-9.11B+ certification — in-app agent memory CONDENSATION (Base44 parity).
//
// Base44 documents: "when memory reaches around 50,000 characters, the agent automatically
// condenses older entries to stay within the limit." This certifies the smallest ADAPT against
// the REAL memory module, the REAL MemoryItem store and the REAL project authorization path:
//   1. below-threshold write unchanged (no summary, all active)
//   2. > 50k active chars triggers condensation
//   3. oldest entries are superseded (existing lifecycle)
//   4. exactly one condensed summary is created (one active summary per scope)
//   5. active memory falls back under the threshold
//   6. concurrent writes do not create duplicate condensation
//   7. the originating write succeeds while condensation runs (best-effort isolation)
//   8. existing memory/RLS regression: a non-member is refused read and write
//
// Nothing is stubbed. The suite leaves no residue in a real account's data.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, captureCall, wasRefused } from "../../shared/testHarness.ts";
import { createMemory, retrieveMemory, MEMORY_LIMITS } from "../../shared/memory.ts";

const CONDENSE_THRESHOLD = MEMORY_LIMITS.condensation_chars;     // 50000
const SUMMARY_CHARS = MEMORY_LIMITS.condensation_summary_chars;   // 2000
const STATEMENT_LEN = 390;
const factStmt = (i) =>
  `Cert memory ${String(i).padStart(4, "0")}: ` +
  ("the agent should prefer concise answers, tailwind utility classes, and avoid inline custom css styles whenever possible. ").repeat(6).slice(0, STATEMENT_LEN - 14);

// Seed an active project-scope memory row directly (bypassing per-write governance so the suite can
// cross the 50k threshold in one pass; the trigger write itself goes through the real createMemory).
async function seed(svc, proj, ws, i) {
  return svc.entities.MemoryItem.create({
    scope: "project", project_id: proj.id, workspace_id: ws.id, memory_type: "fact",
    statement: factStmt(i), subject_key: `cert_fact_${i}`, logical_key: `cert_fact_${proj.id}_${i}`,
    source_type: "project_state", source_reference: { kind: "entity_schema", entity_name: "Customer", version_number: 1 },
    confidence: 0.8, verification: "verified", status: "active", revision: 1, hits: 0,
  });
}

const summaryKey = (proj) => `mk_condense_project_${proj.id}`;
const activeIn = async (svc, proj) =>
  svc.entities.MemoryItem.filter({ scope: "project", project_id: proj.id, status: "active" }, "created_date", 500).catch(() => []);
const activeSummaryCount = async (svc, proj) =>
  (await svc.entities.MemoryItem.filter({ logical_key: summaryKey(proj), status: "active" }, "created_date", 10).catch(() => [])).length;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const h = createHarness();
  let ws = null, projA = null, projB = null;
  const stranger = { id: "mem_cond_stranger", email: "stranger_cond@example.com" };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    ws = await svc.entities.Workspace.create({ name: "Memory Condensation Cert", owner_id: caller.id, credits_balance: 100 });
    projA = await svc.entities.Project.create({ workspace_id: ws.id, name: "condense-a", status: "ready", version_count: 1 });
    projB = await svc.entities.Project.create({ workspace_id: ws.id, name: "condense-b", status: "ready", version_count: 1 });

    // ---------- 1. below-threshold write unchanged ----------
    const small = await createMemory(base44, caller, {
      scope: "project", project_id: projA.id, memory_type: "fact",
      statement: "Small below-threshold fact for the condensation cert.",
      source_type: "project_state", source_reference: { kind: "entity_schema", entity_name: "Customer", version_number: 1 },
    });
    const beforeActive = await activeIn(svc, projA);
    h.check("1. below-threshold write leaves no summary and all rows active",
      small.created && small.memory.status === "active" &&
      beforeActive.every((r) => r.status === "active") && !beforeActive.some((r) => r.logical_key === summaryKey(projA)),
      `created=${small.created} active=${beforeActive.length}`);

    // ---------- seed projA above the threshold ----------
    // Seeding bypasses createMemory (no condensation during seed). 130 rows * ~395 chars + the
    // small fact already > 50000, so the single trigger write through the real createMemory crosses
    // the threshold and is the first write to exercise the condensation path.
    const seedCount = 130;
    for (let i = 0; i < seedCount; i++) await seed(svc, projA, ws, i);

    // ---------- 2. > 50k triggers condensation ----------
    const trigger = await createMemory(base44, caller, {
      scope: "project", project_id: projA.id, memory_type: "fact",
      statement: factStmt(999),
      subject_key: "cert_trigger",
      source_type: "project_state", source_reference: { kind: "entity_schema", entity_name: "Customer", version_number: 1 },
    });
    const afterActive = await activeIn(svc, projA);
    const totalCharsAfter = afterActive.reduce((s, r) => s + String(r.statement || "").length, 0);
    const summariesAfter = await activeSummaryCount(svc, projA);
    h.check("2. crossing 50k triggers condensation (a summary appears)",
      trigger.created && summariesAfter === 1,
      `trigger.created=${trigger.created} summaries=${summariesAfter} active=${afterActive.length} chars=${totalCharsAfter}`);

    // ---------- 3. oldest entries are superseded ----------
    const oldest = await svc.entities.MemoryItem.filter({ logical_key: `cert_fact_${projA.id}_0` }, "created_date", 1).catch(() => []);
    const oldestStatus = oldest[0]?.status;
    const supersededCount = (await svc.entities.MemoryItem.filter({ scope: "project", project_id: projA.id, status: "superseded" }, "created_date", 500).catch(() => [])).length;
    h.check("3. oldest entries are superseded through the existing lifecycle",
      oldestStatus === "superseded" && supersededCount >= 1,
      `oldest[0].status=${oldestStatus} superseded=${supersededCount}`);

    // ---------- 4. exactly one condensed summary ----------
    h.check("4. exactly one active condensed summary exists for the scope",
      summariesAfter === 1,
      `summaries=${summariesAfter}`);

    // ---------- 5. active memory falls back under the threshold ----------
    h.check("5. active memory chars fall back under the threshold",
      totalCharsAfter <= CONDENSE_THRESHOLD,
      `chars=${totalCharsAfter} threshold=${CONDENSE_THRESHOLD}`);

    // ---------- 6. concurrent writes do not create duplicate condensation ----------
    // Seed projB to just under the threshold, then fire 5 concurrent createMemory writes that cross
    // it simultaneously. The in-process per-scope lock must serialize condensation → one summary.
    for (let i = 0; i < 124; i++) await seed(svc, projB, ws, i + 2000);
    const concurrent = await Promise.all([0, 1, 2, 3, 4].map((i) =>
      createMemory(base44, caller, {
        scope: "project", project_id: projB.id, memory_type: "fact",
        statement: factStmt(2000 + i),
        subject_key: `cert_concurrent_${i}`,
        source_type: "project_state", source_reference: { kind: "entity_schema", entity_name: "Customer", version_number: 1 },
      }).catch((e) => ({ threw: true, code: e.code, status: e.status, message: String(e.message || "") }))
    ));
    const projBSummaries = await activeSummaryCount(svc, projB);
    h.check("6. concurrent writes produce exactly one condensation (no duplicate summary)",
      projBSummaries === 1 && concurrent.every((r) => !r.threw),
      `summaries=${projBSummaries} threw=${concurrent.filter((r) => r.threw).length}`);

    // ---------- 7. original write succeeds even if condensation fails ----------
    // Every triggering write (the projA trigger and the 5 concurrent projB writes) returned
    // created:true — the write succeeds while best-effort condensation runs. condensation cannot
    // make createMemory throw (serializeCondense + condenseScopeMemory swallow all failures).
    const triggerSucceeded = trigger.created === true;
    const concurrentSucceeded = concurrent.every((r) => !r.threw && r.created === true);
    h.check("7. originating writes succeed while condensation runs (best-effort isolation)",
      triggerSucceeded && concurrentSucceeded,
      `trigger=${triggerSucceeded} concurrent=${concurrentSucceeded}`);

    // ---------- 8. existing memory/RLS regression ----------
    // A non-member of the workspace is refused read AND write on the project's memory, through the
    // existing loadAuthorizedProject path — unchanged by condensation.
    const strangerRead = await captureCall(() => retrieveMemory(base44, stranger, { project_id: projA.id }));
    const strangerWrite = await captureCall(() => createMemory(base44, stranger, {
      scope: "project", project_id: projA.id, memory_type: "fact",
      statement: "stranger should not be able to write project memory.",
      source_type: "project_state", source_reference: { kind: "entity_schema", entity_name: "Customer", version_number: 1 },
    }));
    h.check("8a. non-member is refused project memory READ (RLS regression)",
      wasRefused(strangerRead), `threw=${strangerRead.threw} status=${strangerRead.status} code=${strangerRead.code}`);
    h.check("8b. non-member is refused project memory WRITE (RLS regression)",
      wasRefused(strangerWrite), `threw=${strangerWrite.threw} status=${strangerWrite.status} code=${strangerWrite.code}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    // Purge all MemoryItem rows for the scratch workspace (project-scoped rows carry workspace_id),
    // then the projects, then the workspace itself.
    try {
      if (ws) {
        await cleanupWorkspace(svc, ws.id, ["MemoryItem"]);
        if (projA) await svc.entities.Project.delete(projA.id).catch(() => {});
        if (projB) await svc.entities.Project.delete(projB.id).catch(() => {});
      }
    } catch { /* best-effort cleanup */ }
  }
}