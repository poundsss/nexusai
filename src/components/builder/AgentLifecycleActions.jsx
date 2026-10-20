import React, { useEffect, useState } from "react";
import { Copy, ArrowRightLeft, Trash2, RotateCcw, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import CloneAgentDialog from "./CloneAgentDialog";

// Agent owner lifecycle — the Base44-documented Agent Settings → General surface: Clone agent,
// Move to workspace, Delete this agent, plus the 30-day Recently-deleted restore. Every action
// calls the certified agentEditor contract (the journalled projectEdit commit path) — nothing
// here invents backend behavior. Deleting disconnects integrations immediately; restore does
// not bring them back (documented).
export default function AgentLifecycleActions({ projectId, agentName, onSaved }) {
  const [cloneOpen, setCloneOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [targets, setTargets] = useState(null);
  const [deleted, setDeleted] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);

  const loadLists = () => {
    workspaceRead("project", { project_id: projectId })
      .then((d) => (d.project?.workspace_id ? workspaceRead("projects", { workspace_id: d.project.workspace_id, sort: "name", limit: 100 }).then((r) => r.projects) : []))
      .then((rows) => setTargets((rows || []).filter((r) => r.id !== projectId).map((r) => ({ id: r.id, name: r.name }))))
      .catch(() => setTargets([]));
    base44.functions.invoke("agentEditor", { action: "list_deleted", project_id: projectId })
      .then((res) => setDeleted(res.data?.recently_deleted || []))
      .catch(() => setDeleted([]));
  };
  useEffect(() => { loadLists(); }, [projectId]);

  const call = async (action, payload, okTitle) => {
    setBusy(action);
    try {
      await base44.functions.invoke("agentEditor", { action, project_id: projectId, ...payload });
      toast({ title: okTitle });
      setConfirming(false);
      if (action === "move" || action === "delete") { if (onSaved) onSaved(); }
      else loadLists();
    } catch (e) {
      toast({ variant: "destructive", title: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setCloneOpen(true)} disabled={busy !== null}>
          <Copy className="h-3 w-3" />Clone agent
        </Button>
        <Button variant="outline" size="sm" onClick={() => setMoveOpen(true)} disabled={busy !== null}>
          <ArrowRightLeft className="h-3 w-3" />Move to workspace
        </Button>
        <Button
          variant="outline" size="sm"
          className={confirming ? "border-destructive/40 text-destructive" : ""}
          disabled={busy !== null}
          onClick={() => { if (!confirming) { setConfirming(true); return; } call("delete", { agent_name: agentName }, "Agent deleted — restorable for 30 days"); }}
        >
          <Trash2 className="h-3 w-3" />{confirming ? "Click again to confirm" : "Delete this agent"}
        </Button>
      </div>
      <p className="mt-1.5 text-[10.5px] text-muted-foreground/60">Deleting disconnects integrations immediately; restore does not bring them back.</p>

      {deleted && deleted.length > 0 && (
        <div className="mt-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Recently deleted</p>
          {deleted.map((d) => (
            <div key={d.path} className="flex items-center gap-2 py-1 text-[12px]">
              <span className="truncate">{d.agent_name}</span>
              <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/60">from v{d.restorable_from_version}</span>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => call("restore", { agent_name: d.agent_name }, "Agent restored")}>
                <RotateCcw className="h-3 w-3" />Restore
              </Button>
            </div>
          ))}
        </div>
      )}

      {cloneOpen && <CloneAgentDialog projectId={projectId} agentName={agentName} onClose={() => setCloneOpen(false)} onSaved={onSaved} />}

      {moveOpen && (
        <Dialog open onOpenChange={(o) => { if (!o) setMoveOpen(false); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="text-[14px]">Move agent</DialogTitle></DialogHeader>
            <p className="text-[11.5px] text-muted-foreground">
              The agent is committed to the target app first, then deleted here — it is never in neither. Cross-workspace grants are cleared.
            </p>
            {targets === null ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : targets.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No other app in this workspace.</p>
            ) : (
              <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-[12px]" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose the target app…</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setMoveOpen(false)}>Cancel</Button>
              <Button size="sm" disabled={!target || busy !== null} onClick={() => call("move", { agent_name: agentName, target_project_id: target }, "Agent moved")}>
                {busy === "move" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Move agent
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}