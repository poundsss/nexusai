// Base44 parity (docs: "Applying a design system to an app that is already built rebuilds the app
// to match"). One-time restyle: true only for the FIRST completed build after a design system was
// selected on a project that already had a completed build. Derived from existing records (the
// selection's audit entry and AIRun) — no new schema fields.
export async function designRestylePending(base44, run, project) {
  if (!project?.design_system_id) return false;
  const [sel] = await base44.entities.AuditLog.filter(
    { project_id: project.id, action: "project_builder_settings.design_system_set" }, "-created_date", 1);
  if (!sel) return false;
  const at = sel.created_date;
  // A run that started before the selection never restyles (keeps plan and generate consistent).
  if (!run?.created_date || !(run.created_date > at)) return false;
  // "Already built" = a completed non-Discuss build before the selection. A new app's initial
  // scaffold version has no such run, so it does not qualify.
  const [prior] = await base44.entities.AIRun.filter(
    { project_id: project.id, status: "COMPLETED", created_date: { $lt: at }, mode: { $ne: "discuss" } }, "-created_date", 1);
  if (!prior) return false;
  const done = await base44.entities.AIRun.filter(
    { project_id: project.id, status: "COMPLETED", created_date: { $gt: at }, mode: { $ne: "discuss" } }, "-created_date", 5);
  return !done.some((r) => r.id !== run.id);
}

export function designRestyleBlock(pending) {
  if (!pending) return "";
  return `

APPLY DESIGN SYSTEM TO EXISTING APP (one-time, overrides any "new components only" rule above for THIS build)
The design system was just selected for an app that is already built. Restyle ALL existing pages and shared UI (layout, navigation, components, token stylesheet) to match the selected system: colors, typography, spacing, radius, shadows and component styling.
Change visual styling only. Preserve behavior, business logic, data contracts, entity usage, routing, auth and props/exports exactly. Do not add, remove or rename features, routes or files' public interfaces.`;
}