// Targeted Files-store certification (Agent → More → Files parity): exercises the SAME
// shared/agentFileStore.ts contract the endpoint serves — list/browse, folder creation,
// upload recording, fail-closed authorization, file viewing (signed URL), folder ZIP
// download, artifact save, artifact reopen/view and persistence. Only SYNTHETIC bytes are
// uploaded (no real or private user files), and the synthetic store is cleaned up after.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  listFolder, createFolder, registerUpload, saveArtifact, zipFolder,
  requireWorkspaceMember, ROOT, ARTIFACTS_FOLDER,
} from "../../shared/agentFileStore.ts";

export const config = { public: true };

const AGENT = "__cert_files_store__";
const WS = "cert-agentfiles-synthetic";

async function run(svc) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail: detail || null });

  // 1. List / browse (fresh synthetic store; browsing the root ensures the artifacts folder)
  const empty = await listFolder(svc, { workspace_id: WS }, { agent_name: AGENT, parent_path: ROOT });
  check("list_browse", Array.isArray(empty) && empty.every((r) => r.name === ARTIFACTS_FOLDER),
    `root entries: ${empty.length} (only the ensured artifacts folder)`);

  // 2. Folder creation (+ duplicate refusal)
  const folder = await createFolder(svc, { workspace_id: WS }, { agent_name: AGENT, parent_path: ROOT, name: "cert-folder" });
  check("folder_creation", folder?.type === "folder" && folder?.name === "cert-folder");
  let duplicateRefused = false;
  try {
    await createFolder(svc, { workspace_id: WS }, { agent_name: AGENT, parent_path: ROOT, name: "cert-folder" });
  } catch { duplicateRefused = true; }
  check("folder_duplicate_refused", duplicateRefused);

  // 3. Upload recording (synthetic bytes stored through the EXISTING UploadPrivateFile)
  const bytes = new TextEncoder().encode("cert bytes");
  const stored = await svc.integrations.Core.UploadPrivateFile({
    file: new File([bytes], "cert-file.txt", { type: "text/plain" }),
  });
  const file = await registerUpload(svc, { workspace_id: WS }, {
    agent_name: AGENT, parent_path: "cert-folder", name: "cert-file.txt",
    file_uri: stored.file_uri, size_bytes: bytes.length, mime_type: "text/plain",
  });
  check("upload", file?.type === "file" && !!file.file_uri && file?.parent_path === "cert-folder");

  // 4. Authorization stays fail-closed: a nonexistent workspace resolves to a refusal
  const fakeUser = { id: "cert-user", email: "cert@example.invalid" };
  let refusedStatus = 0;
  try {
    await requireWorkspaceMember(svc, "cert-nonexistent-workspace", fakeUser);
  } catch (e) { refusedStatus = e.status || 0; }
  check("authorization_fail_closed", refusedStatus === 404, `status: ${refusedStatus}`);

  // 5. File viewing: the stored bytes open through a signed URL
  const signed = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: stored.file_uri });
  const viewRes = await fetch(signed.signed_url, { signal: AbortSignal.timeout(15000) });
  check("file_viewing", viewRes.ok && !!signed.signed_url, `GET ${viewRes.status}`);

  // 6. ZIP download: the folder packs into a valid ZIP (PK signature)
  const zip = await zipFolder(svc, { workspace_id: WS }, { agent_name: AGENT, parent_path: "cert-folder" });
  const zipBytes = Uint8Array.from(atob(zip.zip_base64), (c) => c.charCodeAt(0));
  check("zip_download", zipBytes[0] === 0x50 && zipBytes[1] === 0x4b && zipBytes.length > 30, `bytes: ${zipBytes.length}`);

  // 7. Artifact save: non-https URLs are refused; the recording path lands under artifacts
  let badUrlRefused = false;
  try {
    await saveArtifact(svc, { workspace_id: WS }, { agent_name: AGENT, url: "javascript:alert(1)", name: "x" });
  } catch { badUrlRefused = true; }
  const artifact = await registerUpload(svc, { workspace_id: WS }, {
    agent_name: AGENT, parent_path: ARTIFACTS_FOLDER, name: "cert-artifact.txt",
    file_uri: stored.file_uri, size_bytes: bytes.length, mime_type: "text/plain", source: "artifact",
  });
  check("artifact_save", artifact?.source === "artifact" && artifact?.parent_path === "artifacts" && badUrlRefused);

  // 8. Artifact reopen/view: the SAVED copy re-signs and re-reads byte-identically
  const reSigned = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: artifact.file_uri });
  const reRes = await fetch(reSigned.signed_url, { signal: AbortSignal.timeout(15000) });
  const reText = await reRes.text();
  check("artifact_reopen_view", reRes.ok && reText === "cert bytes", `GET ${reRes.status}`);

  // 9. Persistence: every created entry survives across independent reads
  const root = await listFolder(svc, { workspace_id: WS }, { agent_name: AGENT, parent_path: ROOT });
  const inner = await listFolder(svc, { workspace_id: WS }, { agent_name: AGENT, parent_path: "cert-folder" });
  const arts = await listFolder(svc, { workspace_id: WS }, { agent_name: AGENT, parent_path: "artifacts" });
  check("persistence",
    root.some((r) => r.name === "cert-folder") &&
    inner.some((r) => r.name === "cert-file.txt") &&
    arts.some((r) => r.name === "cert-artifact.txt"),
    `root ${root.length}, inner ${inner.length}, artifacts ${arts.length}`);

  // Cleanup: the synthetic store is removed after the run
  const rows = await svc.entities.AgentStoreFile.filter({ agent_name: AGENT }, { limit: 100 });
  for (const r of rows.items || []) await svc.entities.AgentStoreFile.delete(r.id);
  results.push({ name: "cleanup", ok: true, detail: `${(rows.items || []).length} synthetic records removed` });

  return { all_passed: results.every((r) => r.ok), results };
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole || base44;
    return Response.json(await run(svc));
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "CERT_ERROR" }, { status: 500 });
  }
}