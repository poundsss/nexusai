// Certification for the Bolt-style Design System selector (Phase 1).
//
// Covers the two surfaces the feature adds:
//   1. The static registry + prompt block (base44/shared/designSystemPresets.ts) — pure logic:
//      supported ids, unsupported entries marked honestly, block emission for supported ids,
//      and byte-empty block for null/unsupported ids so run prompts stay unchanged.
//   2. The builder-settings surface (projectBuilderSettings): get default, refusal of an
//      unsupported id, persistence of a supported id, clear-to-null, and cross-project
//      isolation (a selection on one project must never leak into another).
//
// Runs against disposable scratch data only — a scratch project in a scratch workspace, deleted
// in cleanup. No real production project is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  DESIGN_SYSTEM_PRESETS, designSystemPreset, supportedDesignSystemIds,
  isSupportedDesignSystemId, designSystemLibraryBlock,
} from "../../shared/designSystemPresets.ts";

export const config = { method: "POST" };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check } = harness;
  let scratchWorkspaceId = null;
  try {
    // --- 1. Registry contract ------------------------------------------------
    check("exactly the honestly supported systems", JSON.stringify(supportedDesignSystemIds()) === '["shadcn","washington-post","cloudscape","porsche"]', supportedDesignSystemIds().join(","));
    check("corporate presets supported with verified tokens",
      designSystemPreset("washington-post")?.category === "corporate" && designSystemPreset("washington-post")?.tokens?.["--wpds-colors-red100"] === "rgba(234, 0, 23, 1)"
      && designSystemPreset("cloudscape")?.category === "corporate" && designSystemPreset("cloudscape")?.tokens?.["--color-background-button-primary-default"] === "#006ce0"
      && designSystemPreset("porsche")?.category === "corporate" && designSystemPreset("porsche")?.tokens?.["--p-color-focus"] === "#1A44EA",
      "corporate tokens");
    check("material-ui and chakra marked unsupported",
      designSystemPreset("material-ui")?.supported === false && designSystemPreset("chakra")?.supported === false,
      Object.keys(DESIGN_SYSTEM_PRESETS).join(","));
    check("unsupported entries carry a real reason",
      (designSystemPreset("material-ui")?.unsupported_reason || "").includes("npm") &&
      (designSystemPreset("chakra")?.unsupported_reason || "").includes("npm"),
      "reasons present");
    check("isSupportedDesignSystemId rejects unknown ids", isSupportedDesignSystemId("not-a-real-system") === false && isSupportedDesignSystemId(null) === false, "rejected");
    check("shadcn tokens are real documented HSL values",
      designSystemPreset("shadcn")?.tokens?.["--radius"] === "0.5rem" && designSystemPreset("shadcn")?.tokens?.["--primary"] === "240 5.9% 10%",
      "radius+primary");

    // --- 2. Prompt block contract -------------------------------------------
    const block = designSystemLibraryBlock("shadcn");
    check("supported selection emits a block", block.startsWith("SELECTED DESIGN SYSTEM — Shadcn UI"), block.slice(0, 60));
    check("block carries the reference tokens", block.includes("--radius: 0.5rem") && block.includes("--primary: 240 5.9% 10%"), "tokens present");
    check("block never authorizes rewriting existing files", block.includes("does NOT authorize rewriting existing files"), "guard present");
    check("null selection emits an empty block (prompt unchanged)", designSystemLibraryBlock(null) === "", "empty string");
    check("unsupported id emits an empty block (prompt unchanged)", designSystemLibraryBlock("material-ui") === "" && designSystemLibraryBlock("chakra") === "", "empty strings");
    check("corporate selection emits a block", designSystemLibraryBlock("cloudscape").startsWith("SELECTED DESIGN SYSTEM — AWS Cloudscape") && designSystemLibraryBlock("washington-post").includes("--wpds-colors-red100: rgba(234, 0, 23, 1)") && designSystemLibraryBlock("porsche").includes("does NOT authorize rewriting existing files"), "corporate blocks");

    // --- 3. Builder-settings surface (scratch project) -----------------------
    const me = await base44.auth.me();
    const ws = await svc.entities.Workspace.create({ name: `ds-cert-${Date.now()}`, owner_id: me.id });
    scratchWorkspaceId = ws.id;
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: "ds-cert", slug: `ds-cert-${Date.now()}`, status: "draft" });
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: "ds-cert-2", slug: `ds-cert2-${Date.now()}`, status: "draft" });

    const tryInvoke = async (payload) => {
      try {
        const r = await base44.functions.invoke("projectBuilderSettings", payload);
        return { status: r.status ?? 200, data: r.data };
      } catch (e) {
        return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? { error: e.message } };
      }
    };

    check("default selection is null", (await tryInvoke({ action: "get", project_id: proj.id })).data?.design_system_id == null, "null default");
    const refused = await tryInvoke({ action: "set", project_id: proj.id, design_system_id: "not-a-real-system" });
    check("unsupported id is refused server-side", refused.status === 400 && refused.data?.code === "INVALID_DESIGN_SYSTEM", `${refused.status}/${refused.data?.code}`);
    const set1 = await tryInvoke({ action: "set", project_id: proj.id, design_system_id: "shadcn" });
    check("supported id persists", set1.status === 200 && set1.data?.design_system_id === "shadcn", JSON.stringify(set1.data ?? {}));
    check("selection survives a separate read", (await tryInvoke({ action: "get", project_id: proj.id })).data?.design_system_id === "shadcn", "re-read");
    check("selection is project-scoped (isolation)", (await tryInvoke({ action: "get", project_id: proj2.id })).data?.design_system_id == null, "other project null");
    const cleared = await tryInvoke({ action: "set", project_id: proj.id, design_system_id: null });
    check("null clears the selection", cleared.status === 200 && cleared.data?.design_system_id == null, `${cleared.data?.design_system_id}`);
    check("cleared state survives a separate read", (await tryInvoke({ action: "get", project_id: proj.id })).data?.design_system_id == null, "null after clear");

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await cleanupWorkspace(svc, scratchWorkspaceId, ["Project", "AuditLog"]);
    if (scratchWorkspaceId) await purgeBy(svc, "Project", { workspace_id: scratchWorkspaceId });
  }
}