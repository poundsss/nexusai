import React, { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  RefreshCw, GitBranch, GitPullRequest, Plus, Trash2, Loader2,
  PanelLeft, MessageSquare, AlertCircle, X, ExternalLink,
} from "lucide-react";
import FileTree from "@/components/nexuscode/FileTree";
import EditorPane from "@/components/nexuscode/EditorPane";
import EditChat from "@/components/nexuscode/EditChat";
import DiffView from "@/components/nexuscode/DiffView";
import PreviewPanel from "@/components/nexuscode/PreviewPanel";

const invoke = (payload) => base44.functions.invoke("nexusCode", payload);

// The code workspace: persistent repository + branch context in the header, file tree on
// the left, code/preview in the center, and the AI edit chat docked on the right — one
// integrated developer surface. Small screens collapse the tree and chat into toggled
// overlays. All backend behavior is the certified nexusCode surface, unchanged.
export default function CodeWorkspace({ session, onSessionChanged, onDeleted, onAuthLost }) {
  const [files, setFiles] = useState(null);
  const [state, setState] = useState(null);
  const [branches, setBranches] = useState([]);
  const [mode, setMode] = useState("code");
  const [selectedPath, setSelectedPath] = useState(null);
  const [diffPath, setDiffPath] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [startFrom, setStartFrom] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prOpen, setPrOpen] = useState(false);
  const [prComments, setPrComments] = useState(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [chatDraft, setChatDraft] = useState(null);

  const refresh = useCallback(async () => {
    const [t, s] = await Promise.all([
      invoke({ action: "tree", session_id: session.id }).catch(() => null),
      invoke({ action: "state", session_id: session.id }).catch(() => null),
    ]);
    setFiles(t?.data || null);
    setState(s?.data || null);
  }, [session.id]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setSelectedPath(null); setDiffPath(null); }, [session.id]);

  useEffect(() => {
    invoke({ action: "branches", repo_full_name: session.repo_full_name })
      .then((r) => setBranches(r.data?.branches || []))
      .catch(() => {});
  }, [session.repo_full_name, session.working_branch]);

  const run = useCallback(async (payload) => {
    setBusy(true);
    try {
      const r = await invoke({ session_id: session.id, ...payload });
      if (r.data?.session) onSessionChanged(r.data.session);
      await refresh();
      return r.data;
    } catch (e) {
      if (e.response?.status === 428 || e.response?.data?.code === "GITHUB_NOT_CONNECTED") {
        onAuthLost?.();
        return null;
      }
      toast({ variant: "destructive", title: "Nexus Code", description: e.response?.data?.error || e.message });
      return null;
    } finally {
      setBusy(false);
    }
  }, [session.id, onSessionChanged, refresh, onAuthLost]);

  const sendEdit = async (prompt) => {
    setSending(true);
    try {
      const r = await invoke({ action: "edit", session_id: session.id, prompt });
      if (r.data?.session) onSessionChanged(r.data.session);
      await refresh();
    } catch (e) {
      if (e.response?.status === 428 || e.response?.data?.code === "GITHUB_NOT_CONNECTED") {
        onAuthLost?.();
        return;
      }
      toast({ variant: "destructive", title: "Edit failed", description: e.response?.data?.error || e.message });
    } finally {
      setSending(false);
    }
  };

  const commit = async (path, content, message) => {
    const r = await run({ action: "commit", files: [{ path, content }], message });
    if (r) toast({ title: "Committed", description: `${path} → ${session.working_branch}` });
    return r;
  };

  // Explicit recovery for a branch moved outside Nexus Code: adopts the live head only
  // after the user confirms (the resync action) — never a silent overwrite.
  const resync = async () => {
    if (!session.working_branch) return;
    await run({ action: "resync" });
  };

  const loadComments = async () => {
    if (!session.last_pr_number) { setPrComments(null); return; }
    setLoadingComments(true);
    try {
      const r = await invoke({ action: "pr_comments", session_id: session.id });
      setPrComments(r.data || null);
    } catch {
      setPrComments(null);
    } finally {
      setLoadingComments(false);
    }
  };

  // Read-only listing: addressing a comment reuses the EXISTING edit-chat flow.
  const addressComment = (c) => {
    setChatDraft(`Address this review comment on ${c.path}${c.line ? ` (line ${c.line})` : ""}: "${c.body}" — make the change it asks for.`);
    setPrOpen(false);
    setShowChat(true);
  };

  const openPR = async () => {
    const r = await run({ action: "pr", title: prTitle.trim() || `Nexus Code: ${session.working_branch}` });
    if (r) setPrTitle("");
  };

  const remove = async () => {
    // Base44 parity: deleting removes the Nexus Code state only — the GitHub branch remains.
    const ok = window.confirm(
      `Delete the Nexus Code state for this repository? The GitHub branch${session.working_branch ? ` "${session.working_branch}"` : ""} is not removed.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      await invoke({ action: "delete", session_id: session.id });
      onDeleted();
    } catch (e) {
      toast({ variant: "destructive", title: "Delete failed", description: e.response?.data?.error || e.message });
    } finally {
      setBusy(false);
    }
  };

  const diverged = !!(state?.diverged && session.working_branch);
  const currentBranch = session.working_branch || session.base_branch;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Persistent repository / branch / environment context */}
      <div className="h-11 shrink-0 border-b border-border flex items-center gap-2 px-2 sm:px-3">
        <button
          onClick={() => { setShowFiles(!showFiles); setShowChat(false); }}
          className="lg:hidden grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Files"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="font-mono text-[13px] truncate max-w-[150px] sm:max-w-[240px]" title={session.repo_full_name}>
          {session.repo_full_name}
        </span>

        <div className="relative flex items-center gap-1 rounded-md border border-border px-2 h-7 max-w-[220px] shrink-0">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <select
            value={currentBranch}
            onChange={(e) => { const b = e.target.value; if (b !== session.working_branch) run({ action: "switch_branch", branch: b }); }}
            disabled={busy || !branches.length}
            className="appearance-none bg-transparent font-mono text-[12px] pr-1 truncate max-w-[160px] outline-none cursor-pointer disabled:opacity-60"
            title={currentBranch}
          >
            {branches.length === 0 && <option>{currentBranch}</option>}
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}{!session.working_branch && b.name === session.base_branch ? " · base" : ""}
              </option>
            ))}
          </select>
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <button disabled={busy} className="grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50" title="New working branch">
              <Plus className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-2 space-y-2">
            <p className="text-[12px] font-medium">Create working branch</p>
            <select
              value={startFrom || session.base_branch}
              onChange={(e) => setStartFrom(e.target.value)}
              disabled={busy || !branches.length}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]"
              title="Start from"
            >
              {(branches.length ? branches : [{ name: session.base_branch }]).map((b) => (
                <option key={b.name} value={b.name}>Start from: {b.name}</option>
              ))}
            </select>
            <input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="branch name (optional)"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]"
            />
            <button
              onClick={() => { run({ action: "create_branch", name: newBranch.trim(), from_branch: startFrom || session.base_branch }); setNewBranch(""); }}
              disabled={busy}
              className="w-full rounded-md bg-primary px-2.5 py-1.5 text-primary-foreground text-[12px] hover:bg-primary/90 disabled:opacity-50"
            >
              Create
            </button>
          </PopoverContent>
        </Popover>

        <div className="flex-1" />

        <div className="flex items-center rounded-md border border-border p-0.5 shrink-0">
          {[["code", "Code"], ["preview", "Preview"]].map(([id, label]) => (
            <button
              key={id}
              onClick={() => { setMode(id); setDiffPath(null); }}
              className={`px-2.5 py-1 rounded text-[12px] transition-colors ${
                mode === id && !diffPath ? "bg-muted text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <Popover open={prOpen} onOpenChange={(o) => { setPrOpen(o); if (o) loadComments(); }}>
          <PopoverTrigger asChild>
            <button
              disabled={busy || !session.working_branch}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2 h-7 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
              title="Pull request"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">PR</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-3 space-y-2">
            <p className="text-[12px] font-medium flex items-center gap-1.5"><GitPullRequest className="h-3.5 w-3.5" />Pull request</p>
            <p className="font-mono text-[11px] text-muted-foreground">base ← {session.working_branch || session.base_branch}</p>
            <input
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              placeholder="Title (optional — AI drafts from the chat)"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
            />
            <button
              onClick={openPR}
              disabled={busy || !session.working_branch}
              className="w-full rounded-md bg-primary px-2.5 py-1.5 text-primary-foreground text-[12px] hover:bg-primary/90 disabled:opacity-50"
            >
              {session.last_pr_url ? "Continue / open PR" : "Open PR"}
            </button>
            {session.last_pr_url && (
              <a href={session.last_pr_url} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-[12px] text-brand hover:underline">
                PR #{session.last_pr_number} <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {session.last_pr_number && (
              <div className="border-t border-border pt-2 space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">Review comments</p>
                {loadingComments && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                {!loadingComments && prComments && (prComments.comments || []).length === 0 && (prComments.reviews || []).length === 0 && (
                  <p className="text-[11px] text-muted-foreground">No review comments.</p>
                )}
                {!loadingComments && (prComments?.comments || []).map((c) => (
                  <div key={c.id} className="rounded border border-border p-1.5 space-y-1">
                    <p className="font-mono text-[10.5px] text-muted-foreground truncate" title={c.path}>{c.path}{c.line ? `:${c.line}` : ""} · {c.user || "reviewer"}</p>
                    <p className="text-[11px] whitespace-pre-wrap break-words">{c.body}</p>
                    <button onClick={() => addressComment(c)} className="text-[11px] font-semibold text-brand hover:underline">Address in chat</button>
                  </div>
                ))}
                {!loadingComments && (prComments?.reviews || []).map((r) => (
                  <div key={r.id} className="rounded border border-border p-1.5">
                    <p className="text-[10.5px] text-muted-foreground">{r.user || "reviewer"} · {r.state}</p>
                    <p className="text-[11px] whitespace-pre-wrap break-words">{r.body}</p>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>

        <button onClick={refresh} disabled={busy} className="grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50" title="Refresh">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
        <button onClick={remove} disabled={busy} className="grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-destructive transition-colors disabled:opacity-50" title="Delete session">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => { setShowChat(!showChat); setShowFiles(false); }}
          className="lg:hidden grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Edit chat"
        >
          <MessageSquare className="h-4 w-4" />
        </button>
      </div>

      {diverged && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 text-amber-600 text-[12px] border-b border-border">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            Branch {session.working_branch} moved outside Nexus Code — edits are paused.
          </span>
          <button onClick={resync} disabled={busy} className="shrink-0 rounded border border-amber-600/40 px-2 py-0.5 text-[11px] font-semibold hover:bg-amber-500/15 disabled:opacity-50">
            Resync
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex relative">
        {/* File tree — left pane, lg+; toggled overlay below lg */}
        <div className={`${showFiles ? "flex" : "hidden"} lg:flex absolute lg:relative inset-y-0 left-0 z-20 w-60 lg:w-56 shrink-0 bg-background border-r border-border shadow-lg lg:shadow-none`}>
          <FileTree
            loading={!files}
            files={files}
            changes={state?.changed_files || []}
            selected={selectedPath}
            onOpen={(p) => { setSelectedPath(p); setDiffPath(null); setMode("code"); setShowFiles(false); }}
            onDiff={(p) => { setDiffPath(p); setShowFiles(false); }}
          />
        </div>

        {/* Center: diff > selected mode */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {diffPath ? (
            <DiffView sessionId={session.id} path={diffPath} onClose={() => setDiffPath(null)} />
          ) : mode === "preview" ? (
            <PreviewPanel session={session} refreshKey={`${session.working_branch || ""}:${state?.head_sha || ""}`} />
          ) : (
            <EditorPane key={`${session.id}:${selectedPath}`} sessionId={session.id} path={selectedPath} busy={busy} onCommit={commit} />
          )}
        </div>

        {/* AI edit chat — right dock, lg+; toggled overlay below lg */}
        <div className={`${showChat ? "flex" : "hidden"} lg:flex absolute lg:relative inset-y-0 right-0 z-20 w-full sm:w-80 shrink-0 flex-col bg-background border-l border-border shadow-lg lg:shadow-none`}>
          <div className="lg:hidden h-9 shrink-0 border-b border-border flex items-center justify-between px-3">
            <span className="text-[12px] font-medium">Edit chat</span>
            <button onClick={() => setShowChat(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 min-h-0">
            <EditChat session={session} onSend={sendEdit} sending={sending} draft={chatDraft} onDraftConsumed={() => setChatDraft(null)} />
          </div>
        </div>
      </div>
    </div>
  );
}