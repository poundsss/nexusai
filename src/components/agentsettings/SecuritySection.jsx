import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

// 1:1 Base44 Security: agent permissions (what the agent may do on its own), secret
// auto-detection, and the agent's secrets list entry point. The Update/Delete toggles map to
// the agent document's real entity grants (allowed_operations) — that IS the lever the agent
// loop reads; secret auto-detection is a per-agent display preference.
export default function SecuritySection({ agent, isRoot, canEdit, saving, onSave }) {
  const navigate = useNavigate();
  const configs = agent.tool_configs || [];
  const hasOp = (op) => configs.some((t) => (t.allowed_operations || []).includes(op));
  const [autoDetect, setAutoDetect] = useState(() => {
    try { return localStorage.getItem(`superagent_secrets_detect_${agent.name}`) !== "0"; } catch { return true; }
  });

  const toggleOp = (op, on) => {
    const next = configs.map((t) => {
      if (!t.entity_name) return t; // function grants untouched
      const ops = new Set(t.allowed_operations || ["read"]);
      if (on) ops.add(op); else ops.delete(op);
      return { ...t, allowed_operations: [...ops] };
    });
    onSave({ tool_configs: next });
  };

  const addSecret = () => {
    if (isRoot) navigate("/settings");
    else navigate(`/builder/${agent.project_id}`);
  };

  return (
    <div className="max-w-3xl">
      <h2 className="text-[12.5px] font-semibold">Agent permissions</h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">Control what this agent can do on its own, without asking for your approval first.</p>

      <div className="mt-3 flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Update data</p>
          <p className="text-[12.5px] text-muted-foreground">Edit records without asking first</p>
        </div>
        <Switch checked={hasOp("update")} onCheckedChange={(v) => toggleOp("update", v)} disabled={!canEdit || saving} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Delete data</p>
          <p className="text-[12.5px] text-muted-foreground">Remove records without asking first</p>
        </div>
        <Switch checked={hasOp("delete")} onCheckedChange={(v) => toggleOp("delete", v)} disabled={!canEdit || saving} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Auto-detect secrets in messages</p>
          <p className="max-w-lg text-[12.5px] text-muted-foreground">Automatically detect API keys and tokens you paste, save them securely, and hide the raw value from the agent.</p>
        </div>
        <Switch
          checked={autoDetect}
          onCheckedChange={(v) => {
            setAutoDetect(v);
            try { localStorage.setItem(`superagent_secrets_detect_${agent.name}`, v ? "1" : "0"); } catch { /* private mode */ }
          }}
        />
      </div>

      <div className="mt-4 border-t border-border pt-4 flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Secrets</p>
          <p className="max-w-md text-[12.5px] text-muted-foreground">Environment variables available to your agent's backend functions.</p>
        </div>
        <Button variant="outline" className="h-9 gap-1.5 shrink-0" onClick={addSecret}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {isRoot && (
        <p className="mt-3 text-[12.5px] text-muted-foreground">Root agents read the app's own workspace secrets — managed in Settings.</p>
      )}
    </div>
  );
}