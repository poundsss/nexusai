import React, { useState } from "react";
import { Loader2, RefreshCw, Trash2, Power, KeyRound, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STATUS = {
  connected: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  disabled: "bg-slate-100 text-slate-500 ring-slate-200",
  never_connected: "bg-amber-50 text-amber-700 ring-amber-200",
};
const LABEL = { connected: "Connected", error: "Error", disabled: "Disabled", never_connected: "Not connected yet" };

export default function McpConnectionCard({ conn, busy, onAction }) {
  const [openTools, setOpenTools] = useState(false);
  const [secret, setSecret] = useState("");
  const working = busy === conn.id;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[14px] truncate">{conn.name}</span>
            <span className={`text-[10px] rounded px-1.5 py-0.5 ring-1 ${STATUS[conn.status] || STATUS.never_connected}`}>{LABEL[conn.status] || conn.status}</span>
            <span className="text-[10px] text-slate-400 font-mono">{conn.transport}</span>
          </div>
          <p className="mt-1 text-[12px] text-slate-500 font-mono truncate">{conn.server_url}</p>
          <p className="mt-1 text-[12px] text-slate-500">
            {conn.tool_count} tool{conn.tool_count === 1 ? "" : "s"}
            {conn.server_name && ` · ${conn.server_name}${conn.server_version ? ` ${conn.server_version}` : ""}`}
            {conn.protocol_version && ` · MCP ${conn.protocol_version}`}
            {conn.auth_type !== "none" && ` · ${conn.auth_type} auth via ${conn.secret_name}`}
          </p>
          {conn.last_error && <p className="mt-1.5 text-[12px] text-red-600"><span className="font-mono text-[10px] mr-1">{conn.last_error_code}</span>{conn.last_error}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={working} onClick={() => onAction({ action: "test", connection_id: conn.id }, conn.id)}>
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Test</span>
          </Button>
          <Button size="sm" variant="outline" disabled={working} onClick={() => onAction({ action: "set_enabled", connection_id: conn.id, enabled: !conn.enabled }, conn.id)}>
            <Power className="h-3.5 w-3.5" /><span className="ml-1.5">{conn.enabled ? "Disable" : "Enable"}</span>
          </Button>
          <Button size="sm" variant="ghost" disabled={working} onClick={() => onAction({ action: "delete", connection_id: conn.id }, conn.id)}><Trash2 className="h-3.5 w-3.5 text-slate-400" /></Button>
        </div>
      </div>

      {conn.auth_type !== "none" && (
        <div className="mt-3 flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 text-slate-400" />
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder={`Set ${conn.secret_name} (write-only)`} className="h-8 text-[12px] max-w-xs" />
          <Button size="sm" variant="outline" disabled={!secret || working} onClick={async () => { await onAction({ action: "set_secret", connection_id: conn.id, secret_value: secret }, conn.id); setSecret(""); }}>Save</Button>
        </div>
      )}

      {conn.tools.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <button onClick={() => setOpenTools(!openTools)} className="flex items-center gap-1 text-[12px] text-slate-600 hover:text-slate-900">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${openTools ? "" : "-rotate-90"}`} />Discovered tools
          </button>
          {openTools && (
            <ul className="mt-2 space-y-1.5">
              {conn.tools.map((t) => (
                <li key={t.name} className="text-[12px]">
                  <span className="font-mono text-slate-800">{t.name}</span>
                  {t.read_only && <span className="ml-1.5 text-[10px] rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">read-only</span>}
                  {t.description && <p className="text-slate-500 line-clamp-2">{t.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}