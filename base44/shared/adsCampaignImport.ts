// Zernio campaign ingestion: sync the channel's campaigns from the provider, UPDATE the rows the
// project already has (matched by provider_campaign_id) and IMPORT the ones created outside
// NexusAI as new AdsCampaign rows. Read-only towards the provider: only syncCampaigns (a GET)
// is called — nothing is ever created or changed at the advertising provider.
//
// Isolation: every row read/written is scoped to (project_id, channel), workspace_id comes from
// the authorized project, and account_id is the project's own channel account.
// Idempotency: one row per (project_id, channel, provider_campaign_id); a concurrent duplicate
// is collapsed to the oldest row after the pass.

const nowIso = () => new Date().toISOString();
const SERVING = new Set(["PENDING", "ENABLED", "PAUSED", "REMOVED"]);
const ENDED = new Set(["completed", "cancelled"]);
const ROW_CAP = 500;

/** The serving-state enum value for a provider status; the raw value is kept in provider_status. */
export function servingStatus(raw) {
  const s = String(raw || "");
  if (SERVING.has(s)) return s;
  return ENDED.has(s) ? "REMOVED" : "PENDING";
}

async function channelRows(svc, projectId, channel) {
  return (await svc.entities.AdsCampaign.filter({ project_id: projectId, channel }, "created_date", ROW_CAP)) || [];
}

/**
 * opts.window — { fromDate, toDate }: period-scoped metrics. With a window, the stored rows'
 * metrics are NOT overwritten (they hold the default window); the period metrics are returned
 * for the caller (the weekly report) only.
 */
export async function syncAndImportCampaigns(svc, project, account, channel, provider, { window = null } = {}) {
  const sync = await provider.syncCampaigns({ account, window });
  const remote = sync.campaigns || [];
  const rows = await channelRows(svc, project.id, channel);
  const byRef = new Map(rows.filter((r) => r.provider_campaign_id).map((r) => [r.provider_campaign_id, r]));
  const metrics_window = sync.metrics_window || null;
  let created = 0, updated = 0;

  for (const c of remote) {
    const row = byRef.get(c.provider_campaign_id);
    const identity = {
      provider_status: c.status || "", review_status: c.review_status || "",
      serving_status: c.serving_status || "", last_synced_at: nowIso(),
    };
    const metricFields = window ? {} : { metrics: c.metrics || {}, metrics_pending: false, metrics_window };
    if (row) {
      await svc.entities.AdsCampaign.update(row.id, {
        ...identity, ...metricFields,
        status: c.status ? servingStatus(c.status) : row.status,
        ...(row.import_source && c.campaign_name ? { campaign_name: c.campaign_name } : {}),
      });
      updated++;
    } else if (rows.length + created < ROW_CAP) {
      const fresh = await svc.entities.AdsCampaign.create({
        project_id: project.id, workspace_id: project.workspace_id, account_id: account.id, channel,
        campaign_name: c.campaign_name || `Campaign ${c.provider_campaign_id}`,
        campaign_type: "EXTERNAL", status: servingStatus(c.status), import_source: "zernio",
        provider_campaign_id: c.provider_campaign_id,
        ...identity,
        ...(window ? { metrics_pending: true } : metricFields),
      });
      byRef.set(c.provider_campaign_id, fresh);
      created++;
    }
  }

  await collapseDuplicates(svc, project.id, channel);
  const stored = rows.length + created;
  const complete = sync.complete !== false && stored < ROW_CAP + 1 && remote.every((c) => byRef.has(c.provider_campaign_id));
  return { remote, created, updated, complete, provider_total: sync.provider_total ?? null, metrics_window };
}

// A concurrent import can create the same provider campaign twice; keep the oldest row.
async function collapseDuplicates(svc, projectId, channel) {
  const seen = new Set();
  for (const r of await channelRows(svc, projectId, channel)) {
    if (!r.provider_campaign_id) continue;
    if (seen.has(r.provider_campaign_id)) {
      if (r.import_source) await svc.entities.AdsCampaign.delete(r.id).catch(() => {});
    } else seen.add(r.provider_campaign_id);
  }
}