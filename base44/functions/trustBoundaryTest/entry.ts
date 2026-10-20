// End-to-end verification of the three hardened areas, exercised through the SHIPPING code:
//   1. project creation      → shared/projectCreate.ts   (server-authoritative trust boundary)
//   2. preview database CRUD → shared/previewData.ts     (server-authoritative trust boundary)
//   3. AI commit             → shared/commitJournal.ts   (crash-safe atomic persistence)
// Identities are passed explicitly so unauthorized, foreign and anonymous callers can be
// exercised against the real authorization paths.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { seedPlans } from "../../shared/billing.ts";
import { startSubscription } from "../../shared/subscriptions.ts";
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { handlePreviewData } from "../../shared/previewData.ts";
import { prepareCommit, finalizeCommit, recoverPendingCommits, readCanonicalSnapshot, applySnapshot, findJournalForRun } from "../../shared/commitJournal.ts";

const uid = () => crypto.randomUUID().slice(0, 8);
const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail: String(detail ?? "") });
  const bad = (name, detail) => checks.push({ name, ok: false, detail: String(detail ?? "") });
  const expect = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));
  // Asserts a call is refused, and reports the code it was refused with.
  const refused = async (name, fn, expectedCode) => {
    try { const r = await fn(); bad(name, `NOT refused — returned ${JSON.stringify(r).slice(0, 120)}`); }
    catch (e) { expect(name, !expectedCode || e.code === expectedCode || String(e.message).includes(expectedCode), `refused with ${e.code || "?"}: ${e.message.slice(0, 120)}`); }
  };
  const cleanup = [];
  const purge = async (entity, query) => {
    for (const r of await svc.entities[entity].filter(query, "-created_date", 200).catch(() => [])) {
      await svc.entities[entity].delete(r.id).catch(() => {});
    }
  };

  try {
    // --- fixtures: two independent accounts -------------------------------------------
    const userA = { id: `uA-${uid()}`, email: `a-${uid()}@test.local` };
    const userB = { id: `uB-${uid()}`, email: `b-${uid()}@test.local` };
    const wsA = await svc.entities.Workspace.create({ name: "Trust WS A", owner_id: userA.id });
    const wsB = await svc.entities.Workspace.create({ name: "Trust WS B", owner_id: userB.id });
    cleanup.push(() => svc.entities.Workspace.delete(wsA.id), () => svc.entities.Workspace.delete(wsB.id));
    // The suite needs 6 projects in workspace A — beyond the free plan's ceiling of 5. An active
    // Starter subscription (no project ceiling) keeps the suite exercising the trust boundary,
    // not the plan gate, and its billing rows are purged in cleanup.
    await seedPlans(svc);
    await startSubscription(svc, { workspace_id: wsA.id, plan_code: "starter_monthly", user_id: userA.id, trial: false });
    cleanup.push(async () => {
      for (const entity of ["Subscription", "BillingEvent", "CreditLedgerEntry"]) {
        for (const r of await svc.entities[entity].filter({ workspace_id: wsA.id }, "-created_date", 50).catch(() => [])) {
          await svc.entities[entity].delete(r.id).catch(() => {});
        }
      }
    });

    // ================================================================================
    // 1. PROJECT CREATION — server-side trust boundary
    // ================================================================================
    const created = await createProjectForUser(base44, userA, { workspace_id: wsA.id, name: "Authorized App", description: "created by the owner" });
    const projectA = created.project;
    cleanup.push(async () => {
      await purge("ProjectFile", { project_id: projectA.id });
      await purge("ProjectVersion", { project_id: projectA.id });
      await purge("AppEntity", { project_id: projectA.id });
      await purge("AppRecord", { project_id: projectA.id });
      await svc.entities.Project.delete(projectA.id).catch(() => {});
    });
    expect("create_authorized_user", !!projectA?.id && projectA.workspace_id === wsA.id, `project ${projectA?.id} in workspace ${projectA?.workspace_id}`);

    const filesA = await svc.entities.ProjectFile.filter({ project_id: projectA.id }, "path", 50);
    const versionsA = await svc.entities.ProjectVersion.filter({ project_id: projectA.id }, "-number", 5);
    expect("create_files_and_version_belong_to_project", filesA.length === created.files_created && filesA.every((f) => f.project_id === projectA.id) && versionsA.length === 1 && versionsA[0].number === 1 && versionsA[0].project_id === projectA.id,
      `${filesA.length} file(s), version ${versionsA[0]?.number}, all scoped to ${projectA.id}`);

    const auditRows = await svc.entities.AuditLog.filter({ project_id: projectA.id, action: "project.created" }, "-created_date", 5);
    expect("create_audit_written_server_side", auditRows.length === 1 && auditRows[0].user_id === userA.id && auditRows[0].workspace_id === wsA.id,
      `audit user_id=${auditRows[0]?.user_id} workspace=${auditRows[0]?.workspace_id}`);

    await refused("create_unauthorized_workspace_rejected", () => createProjectForUser(base44, userB, { workspace_id: wsA.id, name: "Intruder App" }), "NOT_A_MEMBER");
    await refused("create_forged_workspace_id_rejected", () => createProjectForUser(base44, userA, { workspace_id: wsB.id, name: "Forged App" }), "NOT_A_MEMBER");
    await refused("create_unknown_workspace_id_rejected", () => createProjectForUser(base44, userA, { workspace_id: `ws-${uid()}`, name: "Ghost App" }), "NOT_A_MEMBER");
    await refused("create_anonymous_rejected", () => createProjectForUser(base44, null, { workspace_id: wsA.id, name: "Anon App" }), "AUTH_REQUIRED");
    const leaked = await svc.entities.Project.filter({ workspace_id: wsA.id }, "-created_date", 20);
    expect("create_rejections_wrote_nothing", leaked.length === 1, `${leaked.length} project(s) exist in workspace A`);

    // The browser holds an app-user client: the audit trail is read-only to it.
    await refused("browser_cannot_forge_audit_log", () => base44.entities.AuditLog.create({ workspace_id: wsA.id, project_id: projectA.id, user_id: userB.id, action: "project.created", resource: "Project", resource_id: projectA.id }));

    // ================================================================================
    // 2. PREVIEW DATABASE — server-side trust boundary
    // ================================================================================
    const projectB = (await createProjectForUser(base44, userB, { workspace_id: wsB.id, name: "Other Account App" })).project;
    cleanup.push(async () => {
      await purge("ProjectFile", { project_id: projectB.id });
      await purge("ProjectVersion", { project_id: projectB.id });
      await purge("AppEntity", { project_id: projectB.id });
      await purge("AppRecord", { project_id: projectB.id });
      await svc.entities.Project.delete(projectB.id).catch(() => {});
    });
    const taskDef = { title: { type: "string", required: true }, done: { type: "boolean" } };
    for (const p of [projectA, projectB]) await svc.entities.AppEntity.create({ project_id: p.id, name: "Task", fields: taskDef });

    const asA = (op, args) => handlePreviewData(base44, userA, { project_id: projectA.id, op, args });
    const rec = await asA("create", { entity: "Task", data: { title: "Write tests", done: false } });
    const got = await asA("get", { entity: "Task", id: rec.id });
    const listed = await asA("filter", { entity: "Task", query: { title: "Write tests" } });
    const updated = await asA("update", { entity: "Task", id: rec.id, data: { done: true } });
    const counted = await asA("count", { entity: "Task", query: {} });
    expect("preview_authorized_crud", got.id === rec.id && listed.length === 1 && updated.done === true && counted === 1, `create/get/filter/update/count all served (count=${counted})`);
    await refused("preview_validation_still_enforced", () => asA("create", { entity: "Task", data: { done: true } }), "DATABASE_VALIDATION_FAILED");

    const recB = await handlePreviewData(base44, userB, { project_id: projectB.id, op: "create", args: { entity: "Task", data: { title: "Other account record" } } });
    await refused("preview_unauthorized_project_rejected", () => handlePreviewData(base44, userB, { project_id: projectA.id, op: "filter", args: { entity: "Task" } }), "NOT_A_MEMBER");
    await refused("preview_cross_project_read_rejected", () => asA("get", { entity: "Task", id: recB.id }), "DATABASE_RECORD_NOT_FOUND");
    await refused("preview_cross_project_update_rejected", () => asA("update", { entity: "Task", id: recB.id, data: { done: true } }), "DATABASE_RECORD_NOT_FOUND");
    await refused("preview_cross_project_delete_rejected", () => asA("delete", { entity: "Task", id: recB.id }), "DATABASE_RECORD_NOT_FOUND");
    await refused("preview_forged_project_id_rejected", () => handlePreviewData(base44, userA, { project_id: projectB.id, op: "filter", args: { entity: "Task" } }), "NOT_A_MEMBER");
    await refused("preview_unknown_project_id_rejected", () => handlePreviewData(base44, userA, { project_id: `p-${uid()}`, op: "filter", args: { entity: "Task" } }));
    await refused("preview_anonymous_rejected", () => handlePreviewData(base44, null, { project_id: projectA.id, op: "filter", args: { entity: "Task" } }), "AUTH_REQUIRED");
    const survivor = await svc.entities.AppRecord.get(recB.id).catch(() => null);
    expect("preview_cross_project_record_untouched", !!survivor && survivor.project_id === projectB.id && (survivor.data || {}).done === undefined, "the other account's record was neither read, changed nor deleted");
    const deleted = await asA("delete", { entity: "Task", id: rec.id });
    // delete resolves with the DOCUMENTED DeleteResult { success: true } (SDK 0.8.51 contract).
    expect("preview_own_record_deletable", deleted?.success === true && (await asA("count", { entity: "Task", query: {} })) === 0, "own record deleted, entity now empty");

    // ================================================================================
    // 3. AI COMMIT — crash-safe atomic persistence
    // ================================================================================
    const commitProject = async (label) => {
      const p = (await createProjectForUser(base44, userA, { workspace_id: wsA.id, name: label })).project;
      cleanup.push(async () => {
        await purge("ProjectFile", { project_id: p.id });
        await purge("ProjectVersion", { project_id: p.id });
        await purge("AppEntity", { project_id: p.id });
        await purge("CommitJournal", { project_id: p.id });
        await svc.entities.Project.delete(p.id).catch(() => {});
      });
      return p;
    };
    const runFor = (project, n = 1) => ({ id: `run-${uid()}`, project_id: project.id, base_version_number: n });
    const target = (extra) => ({
      files: [
        { path: "src/main.js", content: "// committed main\n", frozen: false },
        { path: "src/App.js", content: `// committed app ${extra || ""}\n`, frozen: false },
      ],
      entities: [{ name: "Note", fields: { body: { type: "string", required: true } } }],
      secrets: [{ name: "API_KEY", description: "test", required: true }],
    });
    const paths = async (pid) => (await svc.entities.ProjectFile.filter({ project_id: pid }, "path", 100)).map((f) => f.path).sort();

    // 3a. normal commit
    const p1 = await commitProject("Commit Normal");
    const before1 = await readCanonicalSnapshot(base44, p1.id);
    const j1 = await prepareCommit(base44, { project: p1, workspace: wsA, run: runFor(p1), message: "normal commit", changedFiles: [{ path: "src/App.js", change: "modified" }], target: target("v2") });
    const out1 = await finalizeCommit(base44, j1, { runId: j1.run_id });
    const p1After = await svc.entities.Project.get(p1.id);
    const j1After = await svc.entities.CommitJournal.get(j1.id);
    const v1All = await svc.entities.ProjectVersion.filter({ project_id: p1.id }, "-number", 10);
    expect("commit_normal_succeeds", out1.version.number === 2 && p1After.version_count === 2 && j1After.status === "committed" && j1After.version_id === out1.version.id && v1All.length === 2,
      `version ${out1.version.number}, journal ${j1After.status}, ${v1All.length} version(s) total`);
    expect("commit_normal_state_matches_target", JSON.stringify(await paths(p1.id)) === JSON.stringify(["src/App.js", "src/main.js"]) && (await svc.entities.AppEntity.filter({ project_id: p1.id }, "name", 10)).length === 1,
      `files ${(await paths(p1.id)).join(", ")} · scaffold files not in the target were removed (was ${before1.files.length})`);

    // 3b. retry after a successful commit is idempotent
    const out1b = await finalizeCommit(base44, j1After, { runId: j1.run_id });
    const v1Again = await svc.entities.ProjectVersion.filter({ project_id: p1.id }, "-number", 10);
    expect("commit_retry_idempotent", out1b.version.id === out1.version.id && out1b.already_committed === true && v1Again.length === 2 && (await svc.entities.Project.get(p1.id)).version_count === 2,
      `same version ${out1b.version.number} re-used, still ${v1Again.length} version(s)`);
    expect("commit_one_journal_per_run", (await svc.entities.CommitJournal.filter({ run_id: j1.run_id }, "-created_date", 5)).length === 1, "a retry resumed the existing journal instead of opening a second");

    // 3c. crash BEFORE any canonical write (journal 'prepared')
    const p2 = await commitProject("Crash Before Apply");
    const before2 = await readCanonicalSnapshot(base44, p2.id);
    const j2 = await prepareCommit(base44, { project: p2, workspace: wsA, run: runFor(p2), message: "crashed before apply", changedFiles: [], target: target("crash") });
    await svc.entities.CommitJournal.update(j2.id, { heartbeat_at: OLD });   // worker died
    const rec2 = await recoverPendingCommits(base44);
    const j2After = await svc.entities.CommitJournal.get(j2.id);
    const after2 = await readCanonicalSnapshot(base44, p2.id);
    expect("crash_before_commit_recovers", j2After.status === "rolled_back" && JSON.stringify(after2.files.map((f) => f.path).sort()) === JSON.stringify(before2.files.map((f) => f.path).sort()) && (await svc.entities.ProjectVersion.filter({ project_id: p2.id }, "-number", 5)).length === 1,
      `journal ${j2After.status}; ${rec2.recovered.filter((r) => r.journal_id === j2.id).map((r) => r.action).join("")}; canonical state unchanged`);

    // 3d. crash DURING persistence (journal 'applying', canonical partially written)
    const p3 = await commitProject("Crash During Apply");
    const before3 = await readCanonicalSnapshot(base44, p3.id);
    const j3 = await prepareCommit(base44, { project: p3, workspace: wsA, run: runFor(p3), message: "crashed mid-apply", changedFiles: [], target: target("partial") });
    await svc.entities.CommitJournal.update(j3.id, { status: "applying", heartbeat_at: OLD });
    // Partial write: an existing file was overwritten, a brand-new file landed, and an entity
    // was created — then the worker died before the rest of the target was applied.
    const existing = (await svc.entities.ProjectFile.filter({ project_id: p3.id }, "path", 5))[0];
    await svc.entities.ProjectFile.update(existing.id, { content: "// half-written\n" });
    await svc.entities.ProjectFile.create({ project_id: p3.id, path: "src/half-written-new.js", content: "// stray\n", frozen: false });
    await svc.entities.AppEntity.create({ project_id: p3.id, name: "Note", fields: { body: { type: "string" } } });
    await recoverPendingCommits(base44);
    const j3After = await svc.entities.CommitJournal.get(j3.id);
    const after3 = await readCanonicalSnapshot(base44, p3.id);
    const sameFiles = JSON.stringify(after3.files.map((f) => ({ path: f.path, content: f.content })).sort((a, b) => a.path.localeCompare(b.path))) === JSON.stringify(before3.files.map((f) => ({ path: f.path, content: f.content })).sort((a, b) => a.path.localeCompare(b.path)));
    expect("crash_during_persistence_recovers", j3After.status === "rolled_back" && sameFiles && after3.entities.length === before3.entities.length && (await svc.entities.ProjectVersion.filter({ project_id: p3.id }, "-number", 5)).length === 1,
      `journal ${j3After.status}; files and entities restored exactly (${after3.files.length} files, ${after3.entities.length} entities); no version created`);
    expect("no_partial_canonical_state_remains", sameFiles && after3.entities.every((e) => before3.entities.some((b) => b.name === e.name)), "the half-written file content and stray entity are gone");

    // 3e. crash BEFORE version creation (journal 'applied' — canonical already complete)
    const p4 = await commitProject("Crash Before Version");
    const j4 = await prepareCommit(base44, { project: p4, workspace: wsA, run: runFor(p4), message: "crashed before version", changedFiles: [{ path: "src/App.js", change: "modified" }], target: target("rollforward") });
    await applySnapshot(base44, p4.id, target("rollforward"));
    await svc.entities.CommitJournal.update(j4.id, { status: "applied", heartbeat_at: OLD });
    const rec4 = await recoverPendingCommits(base44);
    const j4After = await svc.entities.CommitJournal.get(j4.id);
    const v4 = await svc.entities.ProjectVersion.filter({ project_id: p4.id }, "-number", 10);
    expect("crash_before_version_recovers", j4After.status === "committed" && !!j4After.version_id && v4.length === 2 && v4[0].number === 2 && (await svc.entities.Project.get(p4.id)).version_count === 2,
      `${rec4.recovered.find((r) => r.journal_id === j4.id)?.action}; journal ${j4After.status}; version ${v4[0]?.number}`);
    expect("exactly_one_version_produced", v4.filter((v) => v.run_id === j4.run_id).length === 1, `${v4.filter((v) => v.run_id === j4.run_id).length} version carries this run id`);
    // A worker that comes back and retries must not add another version.
    const j4Retry = await finalizeCommit(base44, await findJournalForRun(base44, j4.run_id), { runId: j4.run_id });
    expect("recovered_commit_retry_idempotent", j4Retry.version.id === j4After.version_id && (await svc.entities.ProjectVersion.filter({ project_id: p4.id }, "-number", 10)).length === 2, "retry after recovery produced no duplicate version");

    // 3f. concurrent version conflict
    const p5 = await commitProject("Concurrent Conflict");
    const j5 = await prepareCommit(base44, { project: p5, workspace: wsA, run: runFor(p5), message: "conflicting commit", changedFiles: [], target: target("conflict") });
    const before5 = await readCanonicalSnapshot(base44, p5.id);
    // Another change lands while this commit was staged.
    await svc.entities.Project.update(p5.id, { version_count: (p5.version_count || 1) + 1 });
    await refused("commit_version_conflict_refused", () => finalizeCommit(base44, j5, { runId: j5.run_id }), "VERSION_CONFLICT");
    const after5 = await readCanonicalSnapshot(base44, p5.id);
    expect("conflict_left_state_untouched", JSON.stringify(after5.files.map((f) => f.path).sort()) === JSON.stringify(before5.files.map((f) => f.path).sort()) && (await svc.entities.CommitJournal.get(j5.id)).status !== "committed",
      `journal ${(await svc.entities.CommitJournal.get(j5.id)).status}; canonical files unchanged`);
  } catch (e) {
    bad("suite_execution", `${e.message}`);
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
    for (const l of await svc.entities.AuditLog.filter({ action: "project.created" }, "-created_date", 50).catch(() => [])) {
      if (String(l.metadata?.name || "").match(/^(Authorized App|Other Account App|Commit |Crash |Concurrent )/)) await svc.entities.AuditLog.delete(l.id).catch(() => {});
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed, checks });
}