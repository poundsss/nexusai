// G-4 — commit-time authorization re-check. Regression harness against real rows.
//
// Verifies, end to end through the REAL pipeline code:
//   1. the exported commit guard (assertCommitAuthorization) resolves the same facts as the
//      control plane: owner/editor pass; a removed member, a viewer, an unknown user and a
//      suspended/terminated workspace are all refused;
//   2. executeRunPhase drives a fabricated run through the REAL commitPhase:
//      an authorized member completes normally (no version, no journal), while a member
//      removed — and a member of a suspended workspace — before commit settles FAILED with
//      AUTHORIZATION_REVOKED, creating no version and no journal;
//   3. the recovery sweep still rolls forward a stale 'applied' journal with NO authorization
//      check (the integrity invariant recovery must keep);
//   4. the exported Git-import guard (assertImporterAuthorization) enforces the same matrix.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { assertCommitAuthorization, executeRunPhase } from "../../shared/runPipeline.ts";
import { assertImporterAuthorization } from "../../shared/gitSync.ts";
import { prepareCommit, recoverPendingCommits } from "../../shared/commitJournal.ts";
import { serializeFs, createFs } from "../../shared/projectFs.ts";
import { packJson } from "../../shared/blobStore.ts";
import { makeChecks } from "../../shared/testChecklist.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const { checks, ok, bad, expect, denied, allowed } = makeChecks();
  const cleanup = [];
  const tidy = (entityName, query) => cleanup.push(() => svc.entities[entityName].deleteMany(query).catch(() => {}));

  try {
    // --- fixtures: one real app user, two workspaces (owner-of-A, editor-member-of-B) ---
    const users = await svc.entities.User.list(5);
    const user = users && users[0];
    if (!user) throw new Error("No app user available to test identity resolution with");

    const wsA = await svc.entities.Workspace.create({ name: "G4 A", owner_id: user.id, status: "active", credits_balance: 0 });
    const wsB = await svc.entities.Workspace.create({ name: "G4 B", owner_id: `g4-synth-owner-${crypto.randomUUID().slice(0, 8)}`, status: "active", credits_balance: 0 });
    tidy("Workspace", { id: wsA.id }); tidy("Workspace", { id: wsB.id });
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: "G4 A Project" });
    const projB = await svc.entities.Project.create({ workspace_id: wsB.id, name: "G4 B Project" });
    tidy("Project", { id: projA.id }); tidy("Project", { id: projB.id });
    tidy("ProjectVersion", { project_id: projA.id }); tidy("ProjectVersion", { project_id: projB.id });
    tidy("CommitJournal", { project_id: projA.id }); tidy("CommitJournal", { project_id: projB.id });
    tidy("Build", { project_id: projA.id }); tidy("Build", { project_id: projB.id });
    const member = await svc.entities.WorkspaceMember.create({
      workspace_id: wsB.id, user_id: user.id, email: user.email, role: "editor", status: "active", accepted_at: new Date().toISOString(),
    });
    tidy("WorkspaceMember", { id: member.id });
    const conv = await svc.entities.Conversation.create({ project_id: projB.id, title: "g4" });
    tidy("Conversation", { id: conv.id }); tidy("Message", { conversation_id: conv.id });
    tidy("AIRun", { conversation_id: conv.id });
    tidy("AIOperation", { workspace_id: wsB.id }); tidy("AIOperation", { workspace_id: wsA.id });
    tidy("CreditLedgerEntry", { workspace_id: wsB.id }); tidy("CreditLedgerEntry", { workspace_id: wsA.id });

    // --- 1. direct guard matrix (AI commit) -------------------------------------------
    await allowed("guard_owner_passes", () => assertCommitAuthorization(svc, { created_by_id: user.id }, wsA));
    await allowed("guard_member_editor_passes", () => assertCommitAuthorization(svc, { initiated_by_user_id: user.id }, wsB));
    await denied("guard_unknown_user_denied", () => assertCommitAuthorization(svc, { initiated_by_user_id: "g4-no-such-user" }, wsB), "NOT_A_MEMBER");
    await svc.entities.WorkspaceMember.update(member.id, { status: "removed" });
    await denied("guard_removed_member_denied", () => assertCommitAuthorization(svc, { initiated_by_user_id: user.id }, wsB), "NOT_A_MEMBER");
    await svc.entities.WorkspaceMember.update(member.id, { status: "active", role: "viewer" });
    await denied("guard_viewer_denied", () => assertCommitAuthorization(svc, { initiated_by_user_id: user.id }, wsB), "INSUFFICIENT_ROLE");
    await svc.entities.WorkspaceMember.update(member.id, { role: "editor" });
    await svc.entities.Workspace.update(wsB.id, { status: "suspended" });
    // The guard consults the row it is handed — re-read so the test exercises it with the
    // suspended state, exactly as the production path (fresh loadContext) would.
    await denied("guard_suspended_workspace_denied", async () => assertCommitAuthorization(svc, { initiated_by_user_id: user.id }, await svc.entities.Workspace.get(wsB.id)), "WORKSPACE_INACTIVE");
    await svc.entities.Workspace.update(wsB.id, { status: "active" });

    // --- 2. REAL commitPhase through executeRunPhase -----------------------------------
    const staging = {
      model: { name: "g4-test", provider: "g4" },
      plan: { message: "g4 test", files: [], entities: [], plan: [] },
      fs: serializeFs(createFs([])), entities: [], secrets: [], failures: [],
      build: { status: "success", errors: 0, logs: [], file_count: 0, duration_ms: 0 },
      usage_by_model: {}, usage_estimated: true,
    };
    const stagingUrl = await packJson(svc, `g4_staging_${crypto.randomUUID()}`, staging);
    const mkRun = () => svc.entities.AIRun.create({
      project_id: projB.id, conversation_id: conv.id, status: "EXECUTING", phase: "commit", mode: "default",
      prompt: "g4 commit auth test", steps: [], base_version_number: projB.version_count || 0,
      staging_url: stagingUrl, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
      initiated_by_user_id: user.id,
    });

    // a) normal commit: authorized editor member completes, nothing mutated, no version.
    const runA = await mkRun();
    const outA = await executeRunPhase(svc, runA.id);
    expect("normal_commit_completes", outA.done === true && outA.status === "COMPLETED", JSON.stringify({ status: outA.status, done: outA.done }));
    expect("normal_commit_no_version", (await svc.entities.ProjectVersion.filter({ project_id: projB.id }, "-number", 5)).length === 0, "no version for a no-change commit");
    expect("normal_commit_no_journal", (await svc.entities.CommitJournal.filter({ run_id: runA.id }, "-created_date", 5)).length === 0, "no journal created");

    // b) membership removed before commit: refused, no version, no journal, no partial state.
    await svc.entities.WorkspaceMember.update(member.id, { status: "removed" });
    const runB = await mkRun();
    const outB = await executeRunPhase(svc, runB.id);
    const rowB = await svc.entities.AIRun.get(runB.id);
    expect("removed_member_commit_failed", outB.status === "FAILED" && rowB.status === "FAILED", `out=${outB.status} row=${rowB.status}`);
    expect("removed_member_commit_reason", String(rowB.error || "").includes("Commit refused") && rowB.phase_error_code === "AUTHORIZATION_REVOKED", `${rowB.phase_error_code}: ${rowB.error}`);
    expect("removed_member_no_version", (await svc.entities.ProjectVersion.filter({ run_id: runB.id }, "-number", 5)).length === 0, "no version created");
    expect("removed_member_no_journal", (await svc.entities.CommitJournal.filter({ run_id: runB.id }, "-created_date", 5)).length === 0, "no journal prepared");
    expect("removed_member_no_files", (await svc.entities.ProjectFile.filter({ project_id: projB.id }, "path", 5)).length === 0, "canonical state untouched");

    // c) workspace suspended before commit: same fail-closed outcome.
    await svc.entities.WorkspaceMember.update(member.id, { status: "active", role: "editor" });
    await svc.entities.Workspace.update(wsB.id, { status: "suspended" });
    const runC = await mkRun();
    const outC = await executeRunPhase(svc, runC.id);
    const rowC = await svc.entities.AIRun.get(runC.id);
    expect("suspended_workspace_commit_failed", outC.status === "FAILED" && rowC.status === "FAILED", `out=${outC.status} row=${rowC.status}`);
    expect("suspended_workspace_commit_reason", rowC.phase_error_code === "AUTHORIZATION_REVOKED", String(rowC.error || ""));
    expect("suspended_workspace_no_version", (await svc.entities.ProjectVersion.filter({ run_id: runC.id }, "-number", 5)).length === 0, "no version created");
    await svc.entities.Workspace.update(wsB.id, { status: "active" });

    // --- 3. recovery sweep: NO auth check, still rolls a stale 'applied' journal forward ----
    const recRun = { id: `g4-recovery-${crypto.randomUUID().slice(0, 8)}`, base_version_number: projA.version_count || 0 };
    const journal = await prepareCommit(svc, {
      project: projA, workspace: wsA, run: recRun, message: "g4 recovery", changedFiles: [],
      target: { files: [], entities: [], secrets: [] },
    });
    await svc.entities.CommitJournal.update(journal.id, { status: "applied", heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const rec = await recoverPendingCommits(svc, {});
    const mine = (rec.recovered || []).find((r) => r.journal_id === journal.id);
    expect("recovery_rolls_forward_without_auth", !!mine && mine.action === "ROLLED_FORWARD" && !!mine.version, JSON.stringify(mine));
    const recJournal = await svc.entities.CommitJournal.get(journal.id);
    expect("recovery_journal_committed", recJournal.status === "committed" && !!recJournal.version_id, recJournal.status);

    // --- 4. Git import guard matrix ------------------------------------------------------
    await allowed("git_guard_owner_passes", () => assertImporterAuthorization(svc, { user_id: user.id, workspace_id: wsA.id }));
    await denied("git_guard_unknown_user_denied", () => assertImporterAuthorization(svc, { user_id: "g4-no-such-user", workspace_id: wsA.id }), "NOT_A_MEMBER");
    await svc.entities.WorkspaceMember.update(member.id, { status: "removed" });
    await denied("git_guard_removed_member_denied", () => assertImporterAuthorization(svc, { user_id: user.id, workspace_id: wsB.id }), "NOT_A_MEMBER");
    await svc.entities.Workspace.update(wsA.id, { status: "terminated" });
    await denied("git_guard_terminated_workspace_denied", () => assertImporterAuthorization(svc, { user_id: user.id, workspace_id: wsA.id }), "WORKSPACE_INACTIVE");
    await svc.entities.Workspace.update(wsA.id, { status: "active" });

    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }
}