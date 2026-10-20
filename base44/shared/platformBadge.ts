// Platform Badge visibility resolution — the single NexusAI-native contract shared by the
// badge settings surface and the published runtime, so both decide identically.
//
// DOCUMENTED Base44 behavior this encodes:
//   • the badge is shown by default (free-plan default);
//   • a project-level setting hides it, but hiding is Starter+ gated (planLimits.badgeRemovalEntitled);
//   • the badge is automatically hidden for private apps (visibility='private'), independent of the
//     setting — a private app never shows the badge even if badge_hidden is false;
//   • a downgraded plan re-shows the badge (the gate is re-checked at render time).
//
// `entitled` is resolved by the CALLER (server-side, from the workspace's effective plan) and
// passed in; this module never trusts a client. The published runtime resolves it only when the
// project actually set badge_hidden, so a free-plan app that never touched the setting pays no
// extra plan lookup at render time.

// The effective badge visibility for a published app. Pure: no IO, no client trust.
export function badgeVisible(project, entitled) {
  if (!project) return false;
  // Private apps never show the badge, regardless of the setting.
  if (project.visibility === "private") return false;
  // badge_hidden only takes effect while the workspace is entitled to hide it; a downgraded plan
  // (entitled === false) re-shows the badge even if the flag is still true.
  if (project.badge_hidden && !entitled) return true;
  if (project.badge_hidden && entitled) return false;
  return true;
}