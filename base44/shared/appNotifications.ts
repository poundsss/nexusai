// In-app notification inbox for a generated app's END USER — the read side of the server-only
// SendPushNotification (which persists one owner-scoped `__notifications` row per send).
// NEXUSAI-DERIVED surface: Base44 documents no notifications SDK; this exposes only the
// recipient's OWN rows. The owner always comes from the verified session, never from args.
import { NOTIFICATIONS_ENTITY } from "./appMessaging.ts";

export const APP_NOTIFICATION_OPS = ["list", "unread_count", "mark_read", "mark_all_read"];
const MAX_LIST = 100;
const MAX_MARK_ALL = 500;

const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const project = (r) => ({ id: r.id, ...(r.data || {}) });

export async function handleAppNotifications(svc, { projectId, user, op, args = {} }) {
  if (!APP_NOTIFICATION_OPS.includes(op)) throw err(400, "NOTIFICATIONS_OP_UNSUPPORTED", `Unsupported notifications operation ${op}`);
  if (!user?.id) throw err(401, "AUTH_REQUIRED", "Sign in to read notifications");
  const mine = { project_id: projectId, entity_name: NOTIFICATIONS_ENTITY, owner_id: String(user.id) };
  const N = svc.entities.AppRecord;

  // Unread rows are found server-side through the top-level `unread` marker (no recency window).
  // Legacy rows written before the marker existed are found by a bounded scan of rows lacking it.
  const unread = async (limit = MAX_MARK_ALL) => {
    const marked = await N.filter({ ...mine, unread: true }, "-created_date", limit);
    const legacy = (await N.filter({ ...mine, unread: null }, "-created_date", MAX_MARK_ALL)).filter((r) => r.data?.read !== true);
    return [...marked, ...legacy].sort((a, b) => String(b.created_date).localeCompare(String(a.created_date))).slice(0, limit);
  };
  const markRead = (r, at) => N.update(r.id, { unread: false, data: { ...(r.data || {}), read: true, read_at: at } });
  if (op === "list") {
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), MAX_LIST);
    const rows = args.unread_only ? await unread(limit) : await N.filter(mine, "-created_date", limit);
    return rows.map(project);
  }
  if (op === "unread_count") {
    const marked = await N.count({ ...mine, unread: true });
    const legacy = (await N.filter({ ...mine, unread: null }, "-created_date", MAX_MARK_ALL)).filter((r) => r.data?.read !== true).length;
    return { count: marked + legacy };
  }
  if (op === "mark_read") {
    const id = String(args.id || "");
    const row = id ? (await N.filter({ ...mine, id }, "-created_date", 1))[0] : null;
    // Another user's (or another project's) row is indistinguishable from a missing one.
    if (!row) throw err(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
    if (row.data?.read === true && row.unread !== true) return project(row);
    return project(await markRead(row, new Date().toISOString()));
  }
  // mark_all_read: bounded per call; has_more tells the caller to repeat.
  const rows = await unread();
  const at = new Date().toISOString();
  for (const r of rows) await markRead(r, at);
  return { updated: rows.length, has_more: rows.length === MAX_MARK_ALL };
}