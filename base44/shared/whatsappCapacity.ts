// R-6 WhatsApp connected-agent capacity (extracted from appAgentChannels). Base44 documents
// "3 in-app agents connected to WhatsApp across all your apps".
import { fail } from "./appAuth.ts";

export const WHATSAPP_MAX_CONNECTED_AGENTS = 3;

// R-6: every read fails closed (retryable 503) and pages through ALL rows — no silent cap.
export const WHATSAPP_CAPACITY_PAGE = 200;
export const WHATSAPP_CAPACITY_CLAIM_TTL_MS = 2 * 60 * 1000;
const capacityUnavailable = () => fail(503, "WHATSAPP_CAPACITY_UNAVAILABLE", "WhatsApp agent capacity could not be verified; retry later.");
async function capacityRead(fn) {
  try { return await fn(); } catch { return capacityUnavailable(); }
}
async function readAll(fn) {
  const out = [];
  for (let skip = 0; ; skip += WHATSAPP_CAPACITY_PAGE) {
    const page = await capacityRead(() => fn(skip));
    out.push(...page);
    if (page.length < WHATSAPP_CAPACITY_PAGE) return out;
  }
}
export async function connectedWhatsAppAgents(svc, workspace_id) {
  const projects = await readAll((skip) => svc.entities.Project.filter({ workspace_id }, "created_date", WHATSAPP_CAPACITY_PAGE, skip));
  const pIds = projects.map((p) => p.id);
  const pairs = new Set();
  for (let i = 0; i < pIds.length; i += WHATSAPP_CAPACITY_PAGE) {
    const ids = pIds.slice(i, i + WHATSAPP_CAPACITY_PAGE);
    const rows = await readAll((skip) => svc.entities.AppIdentity.filter({ project_id: { $in: ids }, provider: "whatsapp", status: "linked" }, "created_date", WHATSAPP_CAPACITY_PAGE, skip));
    for (const r of rows) pairs.add(`${r.project_id}:${String((r.profile || {}).agent || "")}`);
  }
  return pairs;
}

// Final-slot claim (claimDeliveryOnce pattern, but the winner's pair is needed): earliest live
// row wins. UNKNOWN: atomicity depends on database read consistency — no unique constraint.
async function claimFinalSlot(svc, workspace_id, pair, now) {
  const cache_key = `whatsapp_capacity:${workspace_id}`;
  const live = (rows) => rows.filter((r) => new Date(r.expires_at).getTime() > now);
  const read = () => capacityRead(() => svc.entities.CacheEntry.filter({ cache_key }, "created_date", 5)).then(live);
  const existing = await read();
  if (existing.length) return (existing[0].value || {}).pair === pair;
  const expires_at = new Date(now + WHATSAPP_CAPACITY_CLAIM_TTL_MS).toISOString();
  const mine = await capacityRead(() => svc.entities.CacheEntry.create({
    namespace: "whatsapp_capacity", cache_key, value: { pair, claimed_at: new Date(now).toISOString() },
    expires_at, stale_at: expires_at, size_bytes: 64, version: 1,
  }));
  const all = await read();
  return ((all[0] || mine).value || {}).pair === pair;
}

const capacityFull = () => fail(409, "WHATSAPP_AGENT_LIMIT", `This workspace already has ${WHATSAPP_MAX_CONNECTED_AGENTS} in-app agents connected to WhatsApp, which is the maximum.`);

// `reserve` is false at connect-link issuance: an unused link must never hold the final slot.
// Only binding (activation) reserves it, and binding always re-checks.
export async function assertWhatsAppAgentCapacity(svc, project, agentName, { now = Date.now(), reserve = true } = {}) {
  const pair = `${project.id}:${agentName}`;
  const connected = await connectedWhatsAppAgents(svc, project.workspace_id);
  if (connected.has(pair)) return; // re-connecting an already-connected agent
  if (connected.size >= WHATSAPP_MAX_CONNECTED_AGENTS) capacityFull();
  if (!reserve || connected.size < WHATSAPP_MAX_CONNECTED_AGENTS - 1) return; // not reserving the final slot
  if (!(await claimFinalSlot(svc, project.workspace_id, pair, now))) capacityFull();
  const after = await connectedWhatsAppAgents(svc, project.workspace_id);
  if (!after.has(pair) && after.size >= WHATSAPP_MAX_CONNECTED_AGENTS) capacityFull();
}