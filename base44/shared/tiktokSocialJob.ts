import { enqueue } from "./jobQueue.ts";

// A TikTok-only branch of the EXISTING virality.publish job. No new queue, statuses, worker,
// or scheduler. Atomic scheduled->publishing prevents two workers initializing the same post.
export async function executeOwnTikTokJob(svc, row, { publisher, resume = false } = {}) {
  if (row.status === "posted") return { skipped: "already_published", post_id: row.id };
  if (["failed", "needs_reconnect", "publish_outcome_unknown", "not_materialized_plan_limit"].includes(row.status) && !(resume && row.tiktok_publish_id && row.status !== "failed")) return { skipped: `already_${row.status}`, post_id: row.id };
  if (row.status !== "scheduled" && row.status !== "publishing" && !resume) return { skipped: "not_scheduled", post_id: row.id };
  if (row.status === "scheduled") {
    const claimed = await svc.entities.ViralityScheduledPost.updateMany({ id: row.id, project_id: row.project_id, platform: "tiktok", status: "scheduled" }, { $set: { status: "publishing", publish_started_at: new Date().toISOString(), tiktok_poll_count: 0 } });
    if (Number(claimed?.updated) !== 1) return { skipped: "in_flight", post_id: row.id };
    row = await svc.entities.ViralityScheduledPost.get(row.id);
  } else if (!row.tiktok_publish_id) {
    const age = Date.now() - Date.parse(row.publish_started_at || "");
    if (Number.isFinite(age) && age >= 0 && age < 15 * 60000) return { skipped: "in_flight", post_id: row.id };
    await svc.entities.ViralityScheduledPost.update(row.id, { status: "publish_outcome_unknown", publish_started_at: null });
    return { post_id: row.id, status: "publish_outcome_unknown" };
  }
  try {
    const result = await publisher(svc, row);
    if (result?.status === "publishing") {
      const count = Number(row.tiktok_poll_count) || 0;
      if (count >= 240) {
        await svc.entities.ViralityScheduledPost.update(row.id, { status: "publish_outcome_unknown", publish_error: "Local polling limit reached; check the saved TikTok publish_id without resubmitting" });
        return { post_id: row.id, status: "publish_outcome_unknown" };
      }
      const advanced = await svc.entities.ViralityScheduledPost.updateMany({ id: row.id, project_id: row.project_id, tiktok_poll_count: count }, { $set: { status: "publishing", tiktok_poll_count: count + 1, publish_error: null } });
      if (Number(advanced?.updated) === 1) await enqueue(svc, { job_type: "virality.publish", payload: { project_id: row.project_id, post_id: row.id }, idempotency_key: `virality:publish:${row.id}:tiktok-status:${result.publish_id}:${count + 1}`, delay_ms: 60000, max_attempts: 3, project_id: row.project_id, workspace_id: row.workspace_id });
      return { post_id: row.id, status: "publishing", publish_id: result.publish_id };
    }
    if (!["posted", "failed"].includes(result?.status)) throw Object.assign(new Error("Unconfirmed TikTok result"), { code: "PUBLISH_OUTCOME_UNKNOWN" });
    await svc.entities.ViralityScheduledPost.update(row.id, { status: result.status, publish_started_at: null, publish_error: result.error || null, ...(result.status === "posted" ? { tiktok_post_ref: result.ref } : {}) });
    return { post_id: row.id, ...result };
  } catch (error) {
    const persisted = await svc.entities.ViralityScheduledPost.get(row.id);
    const status = ["NO_CONNECTION", "PERMISSION_MISSING", "NOT_A_MEMBER", "INSUFFICIENT_ROLE", "WORKSPACE_INACTIVE", "OAUTH_REFRESH_FAILED"].includes(error.code) ? "needs_reconnect" : error.code === "PUBLISH_OUTCOME_UNKNOWN" || persisted.tiktok_publish_id ? "publish_outcome_unknown" : "failed";
    const message = error.code && /^[A-Z_]+$/.test(error.code) ? `${error.code}: TikTok publishing was not confirmed` : "TikTok publishing was not confirmed";
    await svc.entities.ViralityScheduledPost.update(row.id, { status, publish_started_at: null, publish_error: message });
    return { post_id: row.id, status, error: message };
  }
}