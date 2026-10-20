// Targeted cert for G1 step 1 (Preview runtime:error → RuntimeError). Scratch data, deleted at the end.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import { reportPreviewError } from "../../shared/previewErrorReport.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  const tag = `pe_${crypto.randomUUID().slice(0, 8)}`;
  const owner = { id: `${tag}_owner`, email: `${tag}@x.test` };
  const stranger = { id: `${tag}_stranger`, email: `${tag}_s@x.test` };
  const made = { ws: [], proj: [], run: [], ver: [] };
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  try {
    const ws = await svc.entities.Workspace.create({ name: `${tag}_ws`, owner_id: owner.id }); made.ws.push(ws.id);
    const p = await svc.entities.Project.create({ workspace_id: ws.id, name: `${tag}_a`, version_count: 2 }); made.proj.push(p.id);
    const q = await svc.entities.Project.create({ workspace_id: ws.id, name: `${tag}_b` }); made.proj.push(q.id);
    const run = await svc.entities.AIRun.create({ project_id: p.id, status: "COMPLETED", prompt: "x", trace_id: `${tag}_trace` }); made.run.push(run.id);
    const foreignRun = await svc.entities.AIRun.create({ project_id: q.id, status: "COMPLETED", prompt: "x" }); made.run.push(foreignRun.id);
    const ver = await svc.entities.ProjectVersion.create({ project_id: p.id, number: 2, message: "cert" }); made.ver.push(ver.id);

    // Authorization
    const e401 = await err(() => reportPreviewError(svc, stranger, { project_id: p.id, message: "boom" }));
    h.check("non-member refused 403", e401?.status === 403, `${e401?.status} ${e401?.code}`);
    const eNoProj = await err(() => reportPreviewError(svc, owner, { message: "boom" }));
    h.check("missing project_id refused 400", eNoProj?.status === 400, eNoProj?.status);
    const eMissing = await err(() => reportPreviewError(svc, owner, { project_id: `${tag}_nope`, message: "boom" }));
    h.check("unknown project refused", !!eMissing && eMissing.status !== 200, eMissing?.status);
    const eMsg = await err(() => reportPreviewError(svc, owner, { project_id: p.id, message: "  " }));
    h.check("empty message refused 400", eMsg?.code === "INVALID_INPUT", eMsg?.code);

    // Association validation
    const eRun = await err(() => reportPreviewError(svc, owner, { project_id: p.id, message: "boom", run_id: foreignRun.id }));
    h.check("foreign run refused INVALID_ASSOCIATION", eRun?.code === "INVALID_ASSOCIATION", eRun?.code);
    const eRun2 = await err(() => reportPreviewError(svc, owner, { project_id: p.id, message: "boom", run_id: `${tag}_ghost` }));
    h.check("unknown run refused INVALID_ASSOCIATION", eRun2?.code === "INVALID_ASSOCIATION", eRun2?.code);
    const eVer = await err(() => reportPreviewError(svc, owner, { project_id: p.id, message: "boom", version_number: 99 }));
    h.check("unknown version refused INVALID_ASSOCIATION", eVer?.code === "INVALID_ASSOCIATION", eVer?.code);
    const before = await svc.entities.RuntimeError.filter({ project_id: p.id });
    h.check("refused reports persisted nothing", before.length === 0, before.length);

    // Persistence
    const ok = await reportPreviewError(svc, owner, { project_id: p.id, message: `${tag} TypeError x`, run_id: run.id, version_number: 2, environment: "production", source: "deployed_app", trace_id: "client_forged" });
    const row = await svc.entities.RuntimeError.get(ok.id);
    h.check("row persisted for authorized project", row?.project_id === p.id && row.workspace_id === ws.id, row?.project_id);
    h.check("run + trace from verified run, not client", row.run_id === run.id && row.trace_id === `${tag}_trace`, `${row.run_id} ${row.trace_id}`);
    h.check("version recorded", row.version_number === 2, row.version_number);
    h.check("environment/source forced to preview", row.environment === "preview" && row.source === "preview_runtime", `${row.environment} ${row.source}`);
    const again = await reportPreviewError(svc, owner, { project_id: p.id, message: `${tag} TypeError x` });
    const folded = await svc.entities.RuntimeError.get(ok.id);
    h.check("repeat folded into one row", again.folded && again.id === ok.id && folded.occurrences === 2, `${again.folded} ${folded.occurrences}`);
    const other = await svc.entities.RuntimeError.filter({ project_id: q.id });
    h.check("other project untouched", other.length === 0, other.length);

    // Failure isolation (server): an internal persistence failure surfaces as a thrown error to the
    // endpoint (→ non-2xx), which the Preview's fire-and-forget .catch swallows.
    const eBroken = await err(() => reportPreviewError({ ...svc, asServiceRole: { entities: { ...svc.entities, RuntimeError: { filter: async () => [], create: async () => { throw new Error("db down"); } } } } }, owner, { project_id: p.id, message: `${tag} isolated` }));
    h.check("persistence failure is contained as a thrown error", eBroken?.message === "db down", eBroken?.message);
    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const id of made.proj) for (const r of await svc.entities.RuntimeError.filter({ project_id: id }).catch(() => [])) await svc.entities.RuntimeError.delete(r.id).catch(() => {});
    for (const id of made.ver) await svc.entities.ProjectVersion.delete(id).catch(() => {});
    for (const id of made.run) await svc.entities.AIRun.delete(id).catch(() => {});
    for (const id of made.proj) await svc.entities.Project.delete(id).catch(() => {});
    for (const id of made.ws) await svc.entities.Workspace.delete(id).catch(() => {});
  }
}