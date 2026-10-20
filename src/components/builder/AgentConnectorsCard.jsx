import React, { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { agentConnectorDocs, connectorDocs, connectorUsage, toggleConnectors } from "@/lib/agentConnectors";

// G-K3: the per-agent Connectors surface — a read/derived projection over the files the Builder
// already loaded (enabled from the agent document, available from the connector registry,
// usage from the audited static scan). A toggle persists ONLY through the existing projectEdit
// journalled-commit path, so build validation stays the fail-closed authority.
export default function AgentConnectorsCard({ projectId, files, version, onReload }) {
  const agents = useMemo(() => agentConnectorDocs(files), [files]);
  const connectors = useMemo(() => connectorDocs(files), [files]);
  const usage = useMemo(() => connectorUsage(files, connectors.map((c) => c.name)), [files, connectors]);
  const [busy, setBusy] = useState(null);

  const toggle = async (agent, connector, enabled) => {
    setBusy(`${agent.name}/${connector}`);
    try {
      const content = toggleConnectors(agent.content, connector, enabled);
      const res = await base44.functions.invoke("projectEdit", {
        project_id: projectId,
        action: "commit",
        edits: [{ path: agent.path, content }],
        message: `${enabled ? "Enable" : "Disable"} connector "${connector}" for agent "${agent.name}"`,
        expected_version: typeof version === "number" ? version : null,
      });
      toast({
        title: res.data.unchanged ? "No change" : `Saved as version ${res.data.version.number}`,
        description: `Agent "${agent.name}" · connector ${connector} ${enabled ? "enabled" : "disabled"}`,
      });
      if (onReload) await onReload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not save", description: e.response?.data?.error || e.message });
    } finally {
      setBusy(null);
    }
  };

  if (!agents.length) return null;

  return (
    <div className="mt-4">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Connectors</h3>
      <p className="mt-2 text-[12px] text-muted-foreground mb-2">
        Per in-app agent: which user connectors it may create OAuth connect links for, and the backend functions using each connector. Toggling saves a new version.
      </p>
      {connectors.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-3 text-[12px] text-muted-foreground/60">
          No connectors are set up in this project yet — declare one under Connectors to list it here.
        </div>
      ) : (
        agents.map((agent) => (
          <div key={agent.name} className="mt-2 rounded-md border border-border p-3">
            <p className="font-mono text-[12px] font-medium">{agent.name}</p>
            <div className="mt-1 divide-y divide-border">
              {connectors.map((c) => {
                const enabled = agent.connectors.includes(c.name);
                const usedBy = usage[c.name] || [];
                return (
                  <div key={c.name} className="flex items-start gap-3 py-2">
                    <Switch
                      checked={enabled}
                      disabled={busy !== null}
                      onCheckedChange={(v) => toggle(agent, c.name, v)}
                      aria-label={`${enabled ? "Disable" : "Enable"} connector ${c.name} for agent ${agent.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[12px]">{c.name}</p>
                      <p className="text-[11px] text-muted-foreground/70 truncate">
                        {usedBy.length ? `used by ${usedBy.join(", ")}` : "not used by any backend function"}
                      </p>
                    </div>
                    {busy === `${agent.name}/${c.name}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}