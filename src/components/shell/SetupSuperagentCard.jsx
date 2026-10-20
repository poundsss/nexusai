import React, { useEffect, useState } from "react";
import { Check, Circle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";

// "Setup Superagent" progress card — the Agent-mode sidebar onboarding card. Progress reflects
// the two Plugins capabilities, read live from their certified contracts: connected apps from
// delegatedOAuth `list` (the app-user credential store) and skills from workspaceSkills `list`.
// A contract unavailable in the current context (e.g. AUTH_REQUIRED in the builder) leaves its
// step unchecked — progress is never faked.
export default function SetupSuperagentCard() {
  const { workspace } = useWorkspace();
  const [skills, setSkills] = useState(null);
  const [connected, setConnected] = useState(null);

  useEffect(() => {
    if (!workspace) return;
    base44.functions.invoke("workspaceSkills", { action: "list", workspace_id: workspace.id })
      .then((r) => setSkills(r.data?.skills || []))
      .catch(() => setSkills(null));
  }, [workspace?.id]);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 1 })
      .then(async (d) => {
        const pid = d.projects?.[0]?.id;
        if (!pid) { if (alive) setConnected([]); return; }
        const res = await base44.functions.invoke("delegatedOAuth", { action: "list", project_id: pid }).catch(() => null);
        if (alive) setConnected(res?.data?.credentials || []);
      })
      .catch(() => { if (alive) setConnected([]); });
    return () => { alive = false; };
  }, [workspace?.id]);

  const appCount = (connected || []).filter((c) => c.status === "active").length;
  const skillCount = (skills || []).filter((s) => s.enabled !== false).length;
  const steps = [
    { label: "Connect apps", done: appCount > 0, hint: connected === null ? "…" : appCount ? `${appCount} connected` : "No apps connected yet" },
    { label: "Add skills", done: skillCount > 0, hint: skills === null ? "…" : skillCount ? `${skillCount} enabled` : "None yet" },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11.5px] font-semibold text-sidebar-foreground">Setup Superagent</span>
        <span className="text-[10.5px] text-sidebar-foreground/50">{done}/{steps.length}</span>
      </div>
      <div className="h-1.5 rounded-full bg-sidebar-border/70 overflow-hidden mb-2">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <div className="space-y-1">
        {steps.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5">
            {s.done
              ? <Check className="h-3 w-3 text-emerald-600 shrink-0" />
              : <Circle className="h-3 w-3 text-sidebar-foreground/30 shrink-0" />}
            <span className={`text-[11px] truncate ${s.done ? "text-sidebar-foreground/60 line-through" : "text-sidebar-foreground"}`}>{s.label}</span>
            <span className="ml-auto text-[10px] text-sidebar-foreground/40 shrink-0 truncate">{s.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}