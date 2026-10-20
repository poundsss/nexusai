import React from "react";
import { formatDistanceToNow } from "date-fns";

// Generalized QA run list, extracted from QaActivityTab so the Testing Agent page and the
// Builder's QA tab share one rendering of the same `qa` control plane (no second list logic).
// `onSelect` turns rows into links to a run's detail; absent, it renders the flat history list.
const STATUS_COLOR = {
  PASSED: "text-emerald-600",
  FAILED: "text-destructive",
  REPAIRED: "text-emerald-600",
  REPAIR_FAILED: "text-amber-600",
};

export default function QaRunList({ runs, onSelect, selectedId }) {
  if (!runs || runs.length === 0) {
    return <div className="p-3 text-[11px] text-muted-foreground/60">No QA runs yet.</div>;
  }
  return (
    <table className="w-full">
      <tbody>
        {runs.map((r) => (
          <tr
            key={r.id}
            onClick={onSelect ? () => onSelect(r.id) : undefined}
            className={`border-b border-border/40 ${onSelect ? "cursor-pointer hover:bg-muted/40" : ""} ${selectedId === r.id ? "bg-muted/60" : ""}`}
          >
            <td className={`px-3 py-1.5 w-28 ${STATUS_COLOR[r.status] || "text-muted-foreground"}`}>{r.status}</td>
            <td className="px-3 py-1.5 text-muted-foreground/70 w-44">{r.passed || 0} passed · {r.failed || 0} failed · {r.skipped || 0} skipped</td>
            <td className="px-3 py-1.5 truncate max-w-[240px] text-foreground">{r.terminated_by || "—"}</td>
            <td className="px-3 py-1.5 text-muted-foreground/60 whitespace-nowrap">{r.completed_at ? formatDistanceToNow(new Date(r.completed_at), { addSuffix: true }) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}