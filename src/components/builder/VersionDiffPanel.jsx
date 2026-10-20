import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Loader2 } from "lucide-react";

const MARK = { added: ["+", "text-emerald-600"], modified: ["~", "text-amber-600"], removed: ["-", "text-destructive"] };

// Server-computed comparison of two versions. The server owns the comparison (and its bounds),
// so a large project returns one page of changed files instead of two whole snapshots.
export default function VersionDiffPanel({ projectId, fromVersionId, toVersionId }) {
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setDiff(null); setError(null);
    base44.functions
      .invoke("versionDiff", { project_id: projectId, from_version_id: fromVersionId, to_version_id: toVersionId })
      .then((res) => { if (alive) setDiff(res?.data ?? res); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || e.message); });
    return () => { alive = false; };
  }, [projectId, fromVersionId, toVersionId]);

  if (error) return <div className="text-[11.5px] text-destructive">{error}</div>;
  if (!diff) return <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Comparing…</div>;

  const ent = diff.entities;
  const entityChanges = ent.added.length + ent.removed.length + ent.modified.length;

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-muted-foreground">
        v{diff.from.number} → v{diff.to.number} · {diff.files.added} added, {diff.files.modified} modified, {diff.files.removed} removed, {diff.files.unchanged} unchanged
        {entityChanges ? ` · ${entityChanges} schema change${entityChanges === 1 ? "" : "s"}` : ""}
      </div>
      {diff.files.entries.map((f) => (
        <div key={f.path} className="flex items-center gap-1.5 text-[11.5px] font-mono text-muted-foreground">
          <span className={`w-2 shrink-0 ${MARK[f.change]?.[1]}`}>{MARK[f.change]?.[0]}</span>
          <span className="truncate">{f.path}</span>
          <span className="ml-auto shrink-0 tabular-nums text-[10.5px]">
            <span className="text-emerald-600">+{f.lines_added}</span> <span className="text-destructive">-{f.lines_removed}</span>
          </span>
        </div>
      ))}
      {diff.files.page.has_more && (
        <div className="text-[11px] text-muted-foreground">Showing {diff.files.page.returned} of {diff.files.total_changed} changed files.</div>
      )}
      {ent.modified.map((m) => (
        <div key={m.name} className="text-[11.5px] text-muted-foreground">
          <span className="font-mono">{m.name}</span>: {[...m.fields_added.map((f) => `+${f}`), ...m.fields_removed.map((f) => `-${f}`), ...m.fields_changed.map((c) => `~${c.field}`)].join(", ")}
        </div>
      ))}
      {diff.identical && <div className="text-[11.5px] text-muted-foreground">These versions are identical.</div>}
    </div>
  );
}