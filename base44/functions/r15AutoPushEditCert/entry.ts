// R-15 (PA-12 + PA-9) certification: automatic GitHub push of saved versions. In-memory, no
// database rows and no GitHub calls. The manual-edit backend path is certified by the
// existing collaborationTest suite; the editor UI is a manual check.
import { enqueueAutoPush, drainAutoPush, storeAutoPushToken, AUTO_PUSH_DEFERRED } from "../../shared/githubAutoPush.ts";
import { runGitSyncStep } from "../../shared/gitSync.ts";
import { memStore } from "../../shared/memStoreCert.ts";



const ALLOW = async () => ({ plan: { code: "builder_monthly", entitlements: { github_integration: true } }, source: "subscription" });
const DENY = async () => ({ plan: { code: "free", entitlements: { github_integration: false } }, source: "lapsed" });
const BROKEN = async () => { throw new Error("plan store down"); };
const TOKEN = "gho_CERT_PLAINTEXT_TOKEN_r15";

function seed({ linked = true, token = true } = {}) {
  const m = memStore();
  m.t("Project").push({ id: "p1", workspace_id: "w1", name: "P", version_count: 0 }, { id: "p2", workspace_id: "w1", name: "Q" });
  m.t("Workspace").push({ id: "w1" });
  if (linked) m.t("GitHubLink").push({ id: "l1", project_id: "p1", workspace_id: "w1", connected_by: "u1", repo_full_name: "o/r", branch: "main", status: "connected", created_date: "2026-01-01" });
  m.t("GitHubLink").push({ id: "l2", project_id: "p2", workspace_id: "w1", connected_by: "u2", repo_full_name: "o/other", branch: "main", status: "connected", created_date: "2026-01-01" });
  return { ...m, token };
}
const ver = (m, number, extra = {}) => { const v = { id: `v${number}`, project_id: "p1", number, ...extra }; m.t("ProjectVersion").push(v); return v; };
const runs = (m) => m.t("GitSyncRun").filter((r) => r.project_id === "p1");

export default async function () {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail ?? "").slice(0, 200) });
  try {
    { const m = seed({ linked: false }); const r = await enqueueAutoPush(m.svc, "p1", ver(m, 1), { resolvePlan: ALLOW });
      add("unlinked project: nothing queued or recorded", r.outcome === "not_linked" && runs(m).length === 0, r); }

    { const m = seed(); m.t("GitHubLink")[0].status = "disconnected"; const r = await enqueueAutoPush(m.svc, "p1", ver(m, 1), { resolvePlan: ALLOW });
      add("disconnected link: nothing queued", r.outcome === "not_linked" && runs(m).length === 0, r); }

    { const m = seed(); m.t("GitSyncRun").push({ id: "imp1", project_id: "p1", direction: "import", status: "COMMITTING" });
      const r = await enqueueAutoPush(m.svc, "p1", ver(m, 1, { run_id: "imp1" }), { resolvePlan: ALLOW });
      add("GitHub-import version is never pushed back (no loop)", r.outcome === "skipped_import" && runs(m).length === 1, r); }

    { const m = seed(); const linkBefore = JSON.stringify(m.t("GitHubLink")[0]);
      const r = await enqueueAutoPush(m.svc, "p1", ver(m, 1), { resolvePlan: DENY }); const row = runs(m)[0];
      add("R-8: non-entitled plan records a skip, queues nothing, keeps link", r.outcome === "skipped_plan" && row?.status === "CANCELLED" && row.failure_code === "AUTO_PUSH_SKIPPED_PLAN" && JSON.stringify(m.t("GitHubLink")[0]) === linkBefore, { r, row }); }

    { const m = seed(); const r = await enqueueAutoPush(m.svc, "p1", ver(m, 1), { resolvePlan: BROKEN });
      add("plan read failure fails closed (recorded, not queued)", r.outcome === "blocked_plan_unavailable" && runs(m).every((x) => x.status !== "QUEUED"), r); }

    { const m = seed(); const r = await enqueueAutoPush(m.svc, "p1", ver(m, 1), { resolvePlan: ALLOW });
      add("missing stored credential is recorded as blocked", r.outcome === "blocked_no_credential" && runs(m)[0]?.failure_code === "AUTO_PUSH_NO_CREDENTIAL", r); }

    const m = seed();
    await storeAutoPushToken(m.svc, "w1", "p1", TOKEN);
    const v1 = ver(m, 1);
    const r1 = await enqueueAutoPush(m.svc, "p1", v1, { resolvePlan: ALLOW });
    const q1 = runs(m).find((x) => x.id === r1.run_id);
    add("saved version with credential queues one export", r1.outcome === "queued" && q1?.status === "QUEUED" && q1.direction === "export" && q1.version_number === 1 && !!q1.credential_ref, r1);
    add("auto-push never requests force (fast_forward default)", !q1?.conflict_strategy && !q1?.force_confirm, q1);
    const dump = JSON.stringify({ r1, runs: m.t("GitSyncRun"), secrets: m.t("WorkspaceSecret") });
    add("stored credential never appears in results or rows in plaintext", !dump.includes(TOKEN), dump.length);
    add("cross-project: project B's link is never used", runs(m).every((x) => x.link_id === "l1") && m.t("GitSyncRun").every((x) => x.project_id !== "p2"));

    const dup = await enqueueAutoPush(m.svc, "p1", v1, { resolvePlan: ALLOW });
    add("same version twice is queued once", dup.outcome === "duplicate" && runs(m).length === 1, dup);

    { const m2 = seed(); await storeAutoPushToken(m2.svc, "w1", "p1", TOKEN); const v = ver(m2, 1);
      m2.t("GitSyncRun").push({ id: "man", project_id: "p1", direction: "export", status: "COMPLETED", idempotency_key: "export:p1:v1:o/r:main" });
      const r = await enqueueAutoPush(m2.svc, "p1", v, { resolvePlan: ALLOW });
      add("manual export already done for the version → no auto duplicate", r.outcome === "duplicate" && runs(m2).length === 1, r); }

    // Concurrency: v2 saved while v1's export is still active → deferred, then drained.
    const v2 = ver(m, 2);
    const r2 = await enqueueAutoPush(m.svc, "p1", v2, { resolvePlan: ALLOW });
    add("concurrent save defers behind the running export", r2.outcome === "deferred" && runs(m).find((x) => x.id === r2.run_id)?.cancel_requested === true, r2);
    const w = await runGitSyncStep(m.svc, r2.run_id, { resolvePlan: ALLOW });
    const d2 = runs(m).find((x) => x.id === r2.run_id);
    add("deferred run finishes with AUTO_PUSH_DEFERRED and its job credential destroyed", w.status === "CANCELLED" && d2.failure_code === AUTO_PUSH_DEFERRED && !d2.credential_ref, { w, d2: d2.failure_code });
    add("drain while another operation is active does not stack runs", runs(m).length === 2);

    // v1 export completes → drain pushes the LATEST version (v2), exactly once.
    Object.assign(m.t("GitSyncRun").find((x) => x.id === r1.run_id), { status: "COMPLETED" });
    m.t("GitHubLink")[0].last_export_version_number = 1;
    const dr = await drainAutoPush(m.svc, "p1", { resolvePlan: ALLOW });
    const q2 = runs(m).find((x) => x.id === dr.run_id);
    add("after the running export finishes, the latest version is pushed", dr.outcome === "queued" && q2?.version_number === 2, dr);
    const dr2 = await drainAutoPush(m.svc, "p1", { resolvePlan: ALLOW });
    add("second drain while it runs does nothing", dr2.outcome === "busy", dr2);

    // v2 fails (e.g. genuinely diverged) → drain must not retry forever.
    Object.assign(q2, { status: "FAILED", failure_code: "DIVERGED" });
    const dr3 = await drainAutoPush(m.svc, "p1", { resolvePlan: ALLOW });
    add("a failed push of the latest version is not retried in a loop", dr3.outcome === "duplicate", dr3);

    m.t("GitHubLink")[0].last_export_version_number = 2;
    const dr4 = await drainAutoPush(m.svc, "p1", { resolvePlan: ALLOW });
    add("up-to-date link drains to nothing", dr4.outcome === "up_to_date", dr4);

    const broken = { entities: new Proxy({}, { get: () => ({ filter: async () => { throw new Error("db down"); }, get: async () => { throw new Error("db down"); } }) }) };
    let threw = false; let out;
    try { out = await enqueueAutoPush(broken, "p1", { id: "vx", number: 9 }); } catch { threw = true; }
    add("storage outage never fails the save (fail-safe)", !threw && out?.outcome === "error", out);
  } catch (e) {
    add("harness", false, e?.message);
  }
  const failed = results.filter((r) => !r.ok);
  return Response.json({ suite: "r15AutoPushEditCert", passed: results.length - failed.length, failed: failed.length, total: results.length, results });
}