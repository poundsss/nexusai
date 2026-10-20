import React, { useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMcpConnections } from "@/hooks/useMcpConnections";
import { toast } from "@/components/ui/use-toast";

// The "Add an MCP server" form — Base44 parity: Name, URL, an Authentication pair of radio
// cards (Not required / OAuth), Custom Headers with "+ Add Header", and the Back / Cancel /
// Test / Test & Add footer. Submission runs the EXISTING certified mcpConnections contract,
// whose create performs the real initialize + tools/list check server-side.
const AUTH_OPTIONS = [
  { value: "none", label: "Not required", sub: "Connect without credentials" },
  { value: "oauth", label: "OAuth", sub: "Authorize in the next step" },
];

export default function AddMcpServerDialog({ workspace, onBack, onAdded, onClose }) {
  const { call } = useMcpConnections(workspace?.id);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState("none");
  const [tokenValue, setTokenValue] = useState("");
  const [headers, setHeaders] = useState([]); // { key, value }
  const [busy, setBusy] = useState(false);

  const valid = name.trim().length > 0 && /^https:\/\//.test(url.trim());
  const secretName = `MCP_${name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_") || "SERVER"}_TOKEN`;

  const submit = async () => {
    const headerRows = headers.filter((h) => h.key.trim());
    const authType = headerRows.length ? "header" : auth === "oauth" ? "bearer" : "none";
    if (headerRows.length > 1) {
      toast({ title: "Only the first custom header is applied", description: "The MCP contract stores one custom header per server." });
    }
    setBusy(true);
    const res = await call({
      action: "create",
      name: name.trim(),
      server_url: url.trim(),
      auth_type: authType,
      auth_header_name: headerRows.length ? headerRows[0].key.trim() : "",
      secret_name: authType === "none" ? "" : secretName,
      secret_value: authType === "none" ? "" : (headerRows.length ? headerRows[0].value : tokenValue),
    }, "create");
    setBusy(false);
    if (res?.error) {
      toast({ variant: "destructive", title: "Could not add MCP server", description: res.error.message || String(res.error) });
      return;
    }
    if (res?.error?.message || res?.connection?.status === "error") {
      toast({ variant: "destructive", title: "Added, but the connection test failed", description: res.error?.message || "Check the URL and credentials." });
    } else {
      toast({ title: "MCP server added", description: `${res?.connection?.tool_count || 0} tools discovered.` });
    }
    onAdded();
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden gap-0">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold tracking-tight">Add an MCP server</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-5">
          <div>
            <label className="text-[13px] font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="i.e., My MCP Server" className="mt-1.5 h-10" />
          </div>
          <div>
            <label className="text-[13px] font-medium">URL</label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" className="mt-1.5 h-10" />
          </div>
          <div>
            <label className="text-[13px] font-medium">Authentication</label>
            <div className="mt-1.5 grid grid-cols-2 gap-3 max-w-md">
              {AUTH_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setAuth(o.value)}
                  className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors ${auth === o.value ? "border-foreground/60 bg-muted/40" : "border-border hover:border-border/80"}`}
                >
                  <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${auth === o.value ? "border-foreground" : "border-muted-foreground/50"}`}>
                    {auth === o.value && <span className="h-2 w-2 rounded-full bg-foreground" />}
                  </span>
                  <span>
                    <span className="block text-[13px] font-medium leading-tight">{o.label}</span>
                    <span className="block text-[12px] text-muted-foreground leading-tight mt-0.5">{o.sub}</span>
                  </span>
                </button>
              ))}
            </div>
            {auth === "oauth" && (
              <div className="mt-3 max-w-md space-y-2">
                <label className="text-[12.5px] text-muted-foreground">Bearer credential sent with every request</label>
                <Input value={tokenValue} onChange={(e) => setTokenValue(e.target.value)} type="password" placeholder="Token value" className="h-9" />
                <p className="text-[11px] text-muted-foreground">Stored server-side as <span className="font-mono">{secretName}</span>, encrypted at rest, never shown again.</p>
              </div>
            )}
          </div>
          <div>
            <label className="text-[13px] font-medium">Custom Headers <span className="text-muted-foreground font-normal">(optional)</span></label>
            <p className="text-[12px] text-muted-foreground mt-0.5">Add headers that will be sent with every request (e.g., API keys)</p>
            <div className="mt-2 space-y-2">
              {headers.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={h.key}
                    onChange={(e) => setHeaders(headers.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    placeholder="Header name"
                    className="h-9 flex-1"
                  />
                  <Input
                    value={h.value}
                    onChange={(e) => setHeaders(headers.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    placeholder="Value"
                    className="h-9 flex-1"
                  />
                  <button
                    onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                    className="rounded-md px-2 text-[12px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setHeaders([...headers, { key: "", value: "" }])}>
                + Add Header
              </Button>
            </div>
          </div>
        </div>
        <div className="flex items-center px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onBack}>Back</Button>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="outline" disabled title="Test & Add runs the connection check">Test</Button>
            <Button disabled={!valid || busy} onClick={submit}>{busy ? "Testing…" : "Test & Add"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}