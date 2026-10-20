// C-3.1 step 2: authorized freeze toggle. Replaces direct browser ProjectFile.update calls.
// project.write (also refuses non-active workspaces). Every file_id must belong to the
// authorized project or the whole request is rejected BEFORE any write. Only `frozen` is
// written, via the service role. No version is created (same as the previous direct write);
// writes are independent, so a mid-request failure leaves earlier writes applied (best-effort).
import { loadAuthorizedProject } from "./authz.ts";

const bad = (msg) => Object.assign(new Error(msg), { status: 400, code: "INVALID_REQUEST" });

export async function projectFileFreeze(base44, user, projectId, updates) {
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.write");
  if (!Array.isArray(updates) || !updates.length || updates.length > 500) throw bad("updates must be a non-empty array (max 500)");
  for (const u of updates) {
    if (!u || typeof u.file_id !== "string" || !u.file_id || typeof u.frozen !== "boolean") throw bad("each update needs file_id and boolean frozen");
  }
  const svc = base44.asServiceRole || base44;
  const files = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 5000);
  const own = new Set(files.map((f) => f.id));
  const foreign = updates.filter((u) => !own.has(u.file_id));
  if (foreign.length) throw Object.assign(new Error("File not found in this project"), { status: 404, code: "FILE_NOT_FOUND" });
  await Promise.all(updates.map((u) => svc.entities.ProjectFile.update(u.file_id, { frozen: u.frozen })));
  return { updated: updates.length };
}