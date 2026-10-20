import React, { useState } from "react";
import { RotateCcw, Loader2, GitBranch, Sparkles, Hammer, ChevronRight, Upload } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import DiffView from "./DiffView";
import VersionDiffPanel from "./VersionDiffPanel";

const MARK = { added: ["+", "text-emerald-600"], modified: ["~", "text-amber-600"], deleted: ["-", "text-destructive"] };

// A chronological build history, not an admin table: a timeline rail, one entry per
// version, with actions revealed on the entry itself.
export default function VersionsPane({ versions, onRestore, onPublish, publishing, restoring, compact, projectId }) {
  const [openId, setOpenId] = useState(null);
  const [diffId, setDiffId] = useState(null);
  const [openFile, setOpenFile] = useState(null);
  const latest = versions[0];
  const contentOf = (v, path) => v?.snapshot?.files?.find((f) => f.path === path)?.content || "";

  return (
    <div className="h-full overflow-y-auto bg-background scrollbar-thin">
      <div className={`${compact ? "px-3 py-2" : "px-5 py-3"} border-b border-border text-[11px] text-muted-foreground`}>
        {versions.length} version{versions.length === 1 ? "" : "s"} · restoring creates a new one, history is never rewritten
      </div>

      <div className={compact ? "px-3 py-2" : "px-5 py-4"}>
        {versions.length === 0 && <p className="text-[12px] text-muted-foreground">No versions yet.</p>}
        <ol className="relative">
          {versions.map((v, i) => {
            const parent = versions.find((p) => p.id === v.parent_version_id);
            const open = openId === v.id;
            const isLatest = v.id === latest?.id;
            const changed = (v.changed_files || []).length;
            return (
              <li key={v.id} className="relative pl-6 pb-4 last:pb-0">
                {/* timeline rail */}
                {i !== versions.length - 1 && <span className="absolute left-[5px] top-4 bottom-0 w-px bg-border" />}
                <span className={`absolute left-0 top-[5px] h-[11px] w-[11px] rounded-full border-2 ${isLatest ? "border-foreground bg-foreground" : "border-border bg-background"}`} />

                <div className="group">
                  <div className="flex items-baseline gap-2">
                    <button onClick={() => { setOpenId(open ? null : v.id); setOpenFile(null); }} className="flex items-baseline gap-2 min-w-0 text-left">
                      <span className="font-mono text-[11.5px] font-semibold tabular-nums shrink-0">v{v.number}</span>
                      <span className={`text-[12.5px] ${compact ? "line-clamp-2" : "truncate"} ${isLatest ? "font-medium" : ""}`}>{v.message}</span>
                    </button>
                    {isLatest && <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">current</span>}
                  </div>

                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{formatDistanceToNow(new Date(v.created_date), { addSuffix: true })}</span>
                    <span className="text-border">·</span>
                    <span className="flex items-center gap-1">
                      {v.restored_from_version_id ? <><GitBranch className="h-3 w-3" />restore</> : <><Sparkles className="h-3 w-3" />AI run</>}
                    </span>
                    <span className="text-border">·</span>
                    <span className="flex items-center gap-1"><Hammer className="h-3 w-3" />{changed} file{changed === 1 ? "" : "s"}</span>
                  </div>

                  <div className="mt-1.5 flex items-center gap-2.5 text-[11px]">
                    <button onClick={() => { setOpenId(open ? null : v.id); setOpenFile(null); }} className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors">
                      <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />Compare
                    </button>
                    {!isLatest && (
                      <button onClick={() => onRestore(v)} disabled={!!restoring || !!publishing} className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
                        {restoring === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}Restore
                      </button>
                    )}
                    {!isLatest && onPublish && (
                      <button
                        onClick={() => onPublish(v)}
                        disabled={!!publishing || !!restoring}
                        title="Publish this version to production while keeping your current draft"
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      >
                        {publishing === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}Publish this version
                      </button>
                    )}
                  </div>

                  {open && (
                    <div className="mt-2 space-y-1.5">
                      {changed === 0 && <div className="text-[11.5px] text-muted-foreground">No file changes recorded.</div>}
                      {(v.changed_files || []).map((c) => (
                        <div key={c.path}>
                          <button onClick={() => setOpenFile(openFile === c.path ? null : c.path)} className="flex items-center gap-1.5 text-[11.5px] font-mono text-muted-foreground hover:text-foreground transition-colors max-w-full">
                            <span className={`w-2 shrink-0 ${MARK[c.change]?.[1]}`}>{MARK[c.change]?.[0]}</span>
                            <span className="truncate">{c.path}</span>
                          </button>
                          {openFile === c.path && !compact && <div className="mt-1"><DiffView before={contentOf(parent, c.path)} after={contentOf(v, c.path)} /></div>}
                        </div>
                      ))}
                      {projectId && latest && !isLatest && (
                        <div>
                          <button onClick={() => setDiffId(diffId === v.id ? null : v.id)} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                            {diffId === v.id ? "Hide" : "Diff"} against current (v{latest.number})
                          </button>
                          {diffId === v.id && (
                            <div className="mt-1.5">
                              <VersionDiffPanel projectId={projectId} fromVersionId={v.id} toVersionId={latest.id} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}