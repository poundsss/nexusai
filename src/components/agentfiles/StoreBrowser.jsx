import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Folder, FolderPlus, FileText, MoreVertical, Upload, Download, Eye,
  ChevronRight, ChevronDown, Loader2, FolderOpen,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import FileViewerDialog, { supportedPreviewKind } from "@/components/agentfiles/FileViewerDialog";

// The agent's file store browser (Agent → More → Files): folders and files, the artifacts
// folder for chat-generated artifacts, Add New (upload file / upload folder / new folder),
// folder ZIP download and an in-place file viewer. Records go through the agentStoreFiles
// contract; bytes go through the platform's EXISTING private file storage — never a second
// store, and never a second authorization path (the endpoint is fail-closed).
const joinPath = (parent, name) => (parent ? `${parent}/${name}` : name);
const fmtSize = (n) => (!n ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export default function StoreBrowser({ agentName, workspaceId }) {
  const [cwd, setCwd] = useState(""); // "" = store root
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [viewer, setViewer] = useState(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState("");
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  useEffect(() => {
    // The "upload folder" picker needs the browser's directory flag, which React does not set.
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  const invoke = useCallback(async (payload) => {
    const res = await base44.functions.invoke("agentStoreFiles", {
      workspace_id: workspaceId, agent_name: agentName, ...payload,
    });
    return res.data || {};
  }, [agentName, workspaceId]);

  const load = useCallback(async () => {
    if (!agentName || !workspaceId) return;
    setEntries(null);
    setError(null);
    try {
      const { entries: rows } = await invoke({ action: "list", parent_path: cwd });
      setEntries(rows || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Could not load the file store");
      setEntries([]);
    }
  }, [invoke, cwd]);
  useEffect(() => { load(); }, [load]);

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await invoke({ action: "createFolder", parent_path: cwd, name });
      setFolderDialog(false);
      setFolderName("");
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not create the folder", description: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  };

  // Nested folders of an uploaded folder tree are created first, shallowest-first.
  const ensureDirs = async (dirs) => {
    const seen = {};
    for (const rel of dirs.sort((a, b) => a.split("/").length - b.split("/").length)) {
      const parts = rel.split("/").filter(Boolean);
      let parent = cwd;
      for (const part of parts) {
        const full = joinPath(parent, part);
        if (!seen[full]) {
          const { entries: rows = [] } = await invoke({ action: "list", parent_path: parent });
          if (!rows.some((r) => r.type === "folder" && r.name === part)) {
            await invoke({ action: "createFolder", parent_path: parent, name: part });
          }
          seen[full] = true;
        }
        parent = full;
      }
    }
  };

  const uploadFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setUploadingCount(list.length);
    let ok = 0;
    let failed = 0;
    const dirs = [...new Set(list.map((f) => {
      const rel = f.webkitRelativePath || "";
      return rel.includes("/") ? rel.split("/").slice(1, -1).join("/") : "";
    }).filter(Boolean))];
    try {
      await ensureDirs(dirs);
      for (const f of list) {
        try {
          const rel = f.webkitRelativePath || "";
          const dirRel = rel.includes("/") ? rel.split("/").slice(1, -1).join("/") : "";
          const parent = dirRel ? joinPath(cwd, dirRel) : cwd;
          const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file: f });
          await invoke({
            action: "registerUpload", parent_path: parent, name: f.name,
            file_uri, size_bytes: f.size, mime_type: f.type || "application/octet-stream",
          });
          ok++;
        } catch { failed++; }
      }
    } finally {
      setUploadingCount(0);
    }
    toast({ title: `Uploaded ${ok} file${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}` });
    await load();
  };

  const downloadZip = async (folder) => {
    if (busy) return;
    setBusy(true);
    try {
      const path = folder ? joinPath(cwd, folder.name) : cwd;
      const { filename, zip_base64 } = await invoke({ action: "downloadZip", parent_path: path });
      const bin = atob(zip_base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast({ variant: "destructive", title: "Download failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  };

  const downloadFile = async (f) => {
    try {
      const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri: f.file_uri });
      const blob = await (await fetch(signed_url)).blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast({ variant: "destructive", title: "Download failed", description: e.message });
    }
  };

  const crumbs = cwd ? cwd.split("/") : [];
  const iconCls = "h-3.5 w-3.5";

  return (
    <div>
      {/* Breadcrumb + Add New */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px]">
          <button
            type="button"
            onClick={() => setCwd("")}
            className={`rounded px-1.5 py-1 font-medium transition-colors ${cwd ? "text-muted-foreground hover:text-foreground hover:bg-accent" : "text-foreground"}`}
          >
            Files
          </button>
          {crumbs.map((c, i) => {
            const path = crumbs.slice(0, i + 1).join("/");
            const last = i === crumbs.length - 1;
            return (
              <React.Fragment key={path}>
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                <button
                  type="button"
                  onClick={() => !last && setCwd(path)}
                  className={`truncate rounded px-1.5 py-1 transition-colors ${last ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
                >
                  {c}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        {uploadingCount > 0 && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Uploading {uploadingCount}…
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium shadow-sm hover:bg-accent transition-colors">
              Add New <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
              <Upload className={iconCls} /> Upload file
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => folderInputRef.current?.click()}>
              <FolderOpen className={iconCls} /> Upload folder
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFolderDialog(true)}>
              <FolderPlus className={iconCls} /> New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Listing */}
      {entries === null ? (
        <div className="grid place-items-center rounded-md border border-border py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">{error}</div>
      ) : entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-[12.5px] text-muted-foreground">
          This folder is empty. Upload a file or create a folder to get started.
        </div>
      ) : (
        <div className="rounded-md border border-border divide-y divide-border">
          {entries.map((e) => (
            <div key={e.id} className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-accent/40 transition-colors">
              {e.type === "folder" ? (
                <Folder className={`${iconCls} shrink-0 text-muted-foreground`} />
              ) : (
                <FileText className={`${iconCls} shrink-0 text-muted-foreground`} />
              )}
              {e.type === "folder" ? (
                <button
                  type="button"
                  onClick={() => setCwd(joinPath(cwd, e.name))}
                  className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium hover:underline underline-offset-2"
                >
                  {e.name}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.name}</span>
              )}
              {e.type === "file" && e.source === "artifact" && (
                <span className="shrink-0 rounded-full bg-brand-muted px-2 py-0.5 text-[10.5px] font-medium text-brand">Artifact</span>
              )}
              {e.type === "file" && fmtSize(e.size_bytes) && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{fmtSize(e.size_bytes)}</span>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={`${e.name} actions`} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {e.type === "folder" ? (
                    <>
                      <DropdownMenuItem onSelect={() => setCwd(joinPath(cwd, e.name))}>Open</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => downloadZip(e)}>Download ZIP</DropdownMenuItem>
                    </>
                  ) : (
                    <>
                      {supportedPreviewKind(e) && (
                        <DropdownMenuItem onSelect={() => setViewer(e)}>
                          <Eye className={iconCls} /> View
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => downloadFile(e)}>
                        <Download className={iconCls} /> Download
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}

      {/* Hidden pickers */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(ev) => { uploadFiles(ev.target.files); ev.target.value = ""; }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(ev) => { uploadFiles(ev.target.files); ev.target.value = ""; }}
      />

      {/* New folder dialog */}
      <Dialog open={folderDialog} onOpenChange={setFolderDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px]">New folder</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createFolder(); }}
            placeholder="Folder name"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFolderDialog(false)}>Cancel</Button>
            <Button size="sm" disabled={busy || !folderName.trim()} onClick={createFolder}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File viewer */}
      <FileViewerDialog file={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}