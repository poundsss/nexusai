import React, { useState } from "react";
import { X, Server, Loader2, Trash2, Plus } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMcpConnections } from "@/hooks/useMcpConnections";
import { toast } from "@/components/ui/use-toast";
import AddMcpServerDialog from "./AddMcpServerDialog";

// The "MCP" dialog behind "Add an MCP server" in the Plugins header — Base44 parity: the
// connected-server list with its empty state ("No MCP servers connected yet"), and the
// "Add an MCP server" entry into the add form. The connection lifecycle runs on the EXISTING
// certified mcpConnections contract (list/create/test/delete) — nothing new is added.
export default function McpServersDialog({ open, onOpenChange, workspace }) {
  if (!open) return null;
  return <McpContent onOpenChange={onOpenChange} workspace={workspace} />;
}

function McpContent({ onOpenChange, workspace }) {
  const { connections, busy, error, call } = useMcpConnections(workspace?.id);
  const [addOpen, setAddOpen] = useState(false);

  const remove = async (c) => {
    const res = await call({ action: "delete", name: c.name }, `delete-${c.id}`);
    if (res?.error) toast({ variant: "destructive", title: "Could not remove server", description: res.error.message || String(res.error) });
    else toast({ title: "MCP server removed" });
  };

  return (
    <>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl p-0 overflow-hidden gap-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <h2 className="text-[15px] font-semibold tracking-tight">MCP</h2>
            <button onClick={() => onOpenChange(false)} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="px-6 py-8">
            {error && <p className="text-[12px] text-destructive mb-3">{error}</p>}
            {connections === null ? (
              <div className="py-12 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
            ) : connections.length === 0 ? (
              <div className="py-10 text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-muted">
                  <Server className="h-5 w-5 text-muted-foreground" />
                </div>
                <h3 className="mt-4 text-[15px] font-semibold tracking-tight">No MCP servers connected yet</h3>
                <p className="mt-1.5 mx-auto max-w-md text-[12.5px] text-muted-foreground leading-relaxed">
                  Connect a Model Context Protocol server to give your agent access to custom tools and data.
                </p>
                <Button className="mt-5" disabled={busy !== ""} onClick={() => setAddOpen(true)}>Add an MCP server</Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[13px] font-semibold">Connected servers</h3>
                  <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => setAddOpen(true)}>
                    <Plus className="h-3.5 w-3.5" />Add an MCP server
                  </Button>
                </div>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {connections.map((c) => (
                    <li key={c.id} className="px-3 py-2.5 flex items-center gap-3">
                      <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium truncate">{c.name}</div>
                        <div className="text-[11.5px] text-muted-foreground truncate font-mono">{c.server_url}</div>
                      </div>
                      <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${c.status === "connected" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                        {c.status === "connected" ? `connected · ${c.tool_count || 0} tools` : (c.status || "never_connected").replace(/_/g, " ")}
                      </span>
                      <button
                        onClick={() => remove(c)}
                        disabled={busy === `delete-${c.id}`}
                        title="Remove"
                        className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors"
                      >
                        {busy === `delete-${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {addOpen && (
        <AddMcpServerDialog
          workspace={workspace}
          onBack={() => setAddOpen(false)}
          onAdded={() => setAddOpen(false)}
          onClose={() => { setAddOpen(false); onOpenChange(false); }}
        />
      )}
    </>
  );
}