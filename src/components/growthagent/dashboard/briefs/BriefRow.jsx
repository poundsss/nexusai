import React, { useState } from "react";
import { AlertTriangle, Pencil, Image as ImageIcon, ListChecks } from "lucide-react";
import ReadinessPanel from "./readiness/ReadinessPanel";
import BriefEditor from "./BriefEditor";
import CreativesPanel from "./creatives/CreativesPanel";

// status "ready" only means headlines + descriptions exist — it is NOT launch readiness.
export default function BriefRow({ brief, onSave, projectId }) {
  const [editing, setEditing] = useState(false);
  const [creatives, setCreatives] = useState(false);
  const [ready, setReady] = useState(false);
  const copyDone = brief.headlines.length > 0 && brief.descriptions.length > 0;
  return (
    <li className="py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-foreground">{brief.headlines[0] || "Untitled brief"}</p>
          <p className="text-[11px] text-muted-foreground">
            {brief.campaign_type.replace("_", " ")} · {brief.headlines.length} headlines · {brief.descriptions.length} descriptions
            {brief.budget_micros ? ` · $${brief.budget_micros / 1e6}/day` : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] ${copyDone ? "bg-muted text-foreground" : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"}`}>
          {copyDone ? "Copy complete" : "Draft"}
        </span>
        <button type="button" onClick={() => setReady(!ready)} title="Campaign readiness" className={`grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent ${ready ? "bg-accent" : ""}`}>
          <ListChecks className="h-3 w-3" />
        </button>
        <button type="button" onClick={() => setCreatives(!creatives)} title="Creatives" className={`grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent ${creatives ? "bg-accent" : ""}`}>
          <ImageIcon className="h-3 w-3" />
        </button>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} title="Edit" className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent">
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {brief.generation_warning && (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{brief.generation_warning}
        </p>
      )}
      {ready && <ReadinessPanel projectId={projectId} brief={brief} />}
      {creatives && <CreativesPanel projectId={projectId} brief={brief} onSave={onSave} />}
      {editing && <BriefEditor brief={brief} onCancel={() => setEditing(false)} onSave={async (patch) => { await onSave(brief.id, patch); setEditing(false); }} />}
    </li>
  );
}