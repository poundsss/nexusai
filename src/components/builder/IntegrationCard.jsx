import React from "react";
import { Plug, ShieldCheck, ShieldAlert, AlertTriangle, FileCode, FlaskConical, Pencil, PowerOff, Power } from "lucide-react";

const METHOD_STYLE = { GET: "bg-emerald-500/10 text-emerald-600", POST: "bg-blue-500/10 text-blue-600", PUT: "bg-amber-500/10 text-amber-600", PATCH: "bg-amber-500/10 text-amber-600", DELETE: "bg-destructive/10 text-destructive" };
const btn = "flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors";

export default function IntegrationCard({ integration: i, secretSet, usedBy, onOpenFile, onTest, onEdit, onDisable, onEnable }) {
  if (i.error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-center gap-2 font-medium text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{i.name}</div>
        <p className="text-[12px] text-destructive mt-1">{i.error}</p>
      </div>
    );
  }
  const auth = i.auth || { type: "none" };
  const disabled = i.status === "disabled";
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-start gap-2 p-3 border-b border-border/40">
        <Plug className="h-4 w-4 text-muted-foreground mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold font-mono">{i.name}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{i.type}</span>
            {disabled && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600">disabled</span>}
            <button onClick={onOpenFile} className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"><FileCode className="h-3 w-3" />definition</button>
          </div>
          {i.description && <p className="text-[12px] text-muted-foreground mt-0.5">{i.description}</p>}
          <div className="font-mono text-[11px] text-muted-foreground mt-1 truncate">{i.base_url || i.server_url}</div>
          <div className="flex items-center gap-1.5 text-[11px] mt-1.5">
            {auth.type === "none" ? <span className="text-muted-foreground/60">No authentication</span> : (
              <>
                {secretSet ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> : <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />}
                <span className="text-muted-foreground">{auth.type === "bearer" ? "Bearer token" : auth.type === "oauth2" ? "OAuth2 (M2M)" : `API key (${auth.in} ${auth.header_name})`} from secret</span>
                <span className="font-mono">{auth.secret}</span>
                <span className={secretSet ? "text-emerald-600" : "text-amber-600"}>{secretSet ? "· set" : "· not set"}</span>
              </>
            )}
          </div>
          {usedBy.length > 0 && <div className="text-[11px] text-muted-foreground mt-1">Used by: <span className="font-mono">{usedBy.join(", ")}</span></div>}
        </div>
      </div>
      <div className="divide-y divide-border/40">
        {(i.operations || []).length === 0 && <div className="p-3 text-[12px] text-muted-foreground/60">No operations declared.</div>}
        {(i.operations || []).map((op) => (
          <div key={op.name} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
            <span className={`w-14 shrink-0 text-center rounded px-1 py-0.5 font-mono text-[10px] ${METHOD_STYLE[op.method] || "bg-muted text-muted-foreground"}`}>{op.method}</span>
            <span className="font-mono text-foreground">{op.name}</span>
            <span className="font-mono text-muted-foreground/60 truncate">{op.path}</span>
            {op.parameters?.length > 0 && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">{op.parameters.map((p) => p.name).join(", ")}</span>}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 px-3 py-2 border-t border-border/40">
        <button onClick={onTest} className={btn} disabled={disabled}><FlaskConical className="h-3 w-3" />Test</button>
        <button onClick={onEdit} className={btn}><Pencil className="h-3 w-3" />Edit</button>
        {disabled
          ? <button onClick={onEnable} className={`ml-auto ${btn} text-emerald-600 hover:text-emerald-600`}><Power className="h-3 w-3" />Enable</button>
          : <button onClick={onDisable} className={`ml-auto ${btn}`}><PowerOff className="h-3 w-3" />Disable</button>}
      </div>
    </div>
  );
}