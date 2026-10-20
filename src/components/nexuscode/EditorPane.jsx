import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Loader2, GitCommitHorizontal } from "lucide-react";

const invoke = (payload) => base44.functions.invoke("nexusCode", payload);

// Center code pane: one repository file, editable. A commit & push runs through the
// certified manual-commit surface (same branch head guard), never a side channel.
export default function EditorPane({ sessionId, path, busy, onCommit }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setContent(null); setDirty(false); setOpen(false); setMessage("");
    if (!path) return;
    setLoading(true);
    invoke({ action: "file", session_id: sessionId, path })
      .then((r) => { if (alive) setContent(r.data?.content ?? ""); })
      .catch((e) => { if (alive) setContent(`// could not load this file: ${e.response?.data?.error || e.message}`); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, path]);

  const commit = async () => {
    if (!path || committing) return;
    setCommitting(true);
    try {
      const r = await onCommit(path, content, message.trim() || `Update ${path}`);
      if (r) {
        // The server is the source of truth after a push — re-read the pushed file.
        const f = await invoke({ action: "file", session_id: sessionId, path });
        setContent(f.data?.content ?? content);
        setDirty(false); setOpen(false); setMessage("");
      }
    } finally {
      setCommitting(false);
    }
  };

  if (!path) {
    return <div className="flex-1 w-full grid place-items-center text-[13px] text-muted-foreground/60">Select a file to open it in the editor.</div>;
  }

  return (
    <div className="flex-1 min-h-0 w-full flex flex-col">
      <div className="h-9 shrink-0 border-b border-border flex items-center gap-2 px-3">
        <span className="flex-1 min-w-0 font-mono text-[12px] truncate" title={path}>{path}</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin shrink-0 text-muted-foreground" />}
        <button
          onClick={() => setOpen(!open)}
          disabled={busy || committing}
          className={`shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-muted disabled:opacity-50 ${
            dirty ? "text-amber-600" : "text-muted-foreground"
          }`}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5" />
          Commit &amp; push{dirty ? " •" : ""}
        </button>
      </div>
      {open && (
        <div className="shrink-0 border-b border-border p-2 flex gap-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
            placeholder="Commit message"
            className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
            autoFocus
          />
          <button
            onClick={commit}
            disabled={committing || busy}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-primary-foreground text-[12px] hover:bg-primary/90 disabled:opacity-50"
          >
            {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Push"}
          </button>
          <button onClick={() => setOpen(false)} className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-muted">Cancel</button>
        </div>
      )}
      <textarea
        value={content ?? ""}
        onChange={(e) => { setContent(e.target.value); setDirty(true); }}
        spellCheck={false}
        readOnly={loading}
        className="flex-1 min-h-0 w-full resize-none bg-background p-3 font-mono text-[12px] leading-5 outline-none scrollbar-thin"
      />
    </div>
  );
}