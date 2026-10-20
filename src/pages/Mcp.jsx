import React, { useMemo, useState } from "react";
import { Plus, Plug, Search } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useMcpConnections } from "@/hooks/useMcpConnections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AccountPage from "@/components/shell/AccountPage";
import McpConnectionCard from "@/components/mcp/McpConnectionCard";
import NewMcpConnectionDialog from "@/components/mcp/NewMcpConnectionDialog";

export default function Mcp() {
  const { user, workspace } = useWorkspace();
  const { connections, busy, error, call } = useMcpConnections(workspace?.id);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const list = connections || [];
    const term = q.trim().toLowerCase();
    if (!term) return list;
    return list.filter((c) => `${c.name || ""} ${c.server_url || ""}`.toLowerCase().includes(term));
  }, [connections, q]);

  return (
    <AccountPage
      title="Integrations"
      subtitle="MCP servers the Builder AI can call while working on your applications."
      actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />Add connection</Button>}
    >
      {error && <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">{error}</p>}

      {!connections ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-20 rounded-lg border border-border bg-muted/30 animate-pulse" />)}
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-lg border border-border py-16 text-center">
          <Plug className="h-5 w-5 mx-auto text-muted-foreground" />
          <h3 className="mt-3 text-[14px] font-semibold">No integrations connected</h3>
          <p className="mt-1.5 mx-auto max-w-sm text-[12.5px] text-muted-foreground">
            Connect an MCP server over Streamable HTTP and its tools become available to the Builder AI while it works on your apps.
          </p>
          <Button size="sm" className="mt-5" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />Add connection</Button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search integrations…" className="pl-9 h-9 text-[13px]" />
            </div>
            <span className="text-[11.5px] text-muted-foreground">{filtered.length} of {connections.length}</span>
          </div>
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-border py-12 text-center text-[12.5px] text-muted-foreground">
              No integration matches “{q}”.
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((c) => <McpConnectionCard key={c.id} conn={c} busy={busy} onAction={(payload, key) => call(payload, key)} />)}
            </div>
          )}
        </>
      )}

      <NewMcpConnectionDialog open={open} onOpenChange={setOpen} busy={busy === "create"} onCreate={(form) => call({ action: "create", ...form }, "create")} />
    </AccountPage>
  );
}