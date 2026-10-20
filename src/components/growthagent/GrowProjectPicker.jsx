import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";

// The project scope picker shared by the read-only Grow panels. The rollup and every
// project-scoped read are keyed by project id — no other scope exists — so the panels offer
// exactly the workspace's projects, most recent first.
export default function GrowProjectPicker({ workspace, projectId, onChange, label = "Project" }) {
  const [projects, setProjects] = useState(null);

  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50, fields: ["id", "name"] })
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
  }, [workspace]);

  if (!Array.isArray(projects) || projects.length === 0) return null;
  return (
    <div className="mb-5 flex items-center gap-2.5">
      <label htmlFor={`grow-picker-${label}`} className="text-[12.5px] text-muted-foreground shrink-0">{label}</label>
      <select
        id={`grow-picker-${label}`}
        value={projectId || ""}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[16rem] rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px] text-foreground outline-none focus:border-foreground/30"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id} className="bg-background text-foreground">{p.name}</option>
        ))}
      </select>
    </div>
  );
}