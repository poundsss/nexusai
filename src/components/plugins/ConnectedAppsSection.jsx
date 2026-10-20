import React from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import ConnectorIcon from "./ConnectorIcon";

const STATUS_TONE = {
  active: "bg-emerald-500/10 text-emerald-600", expired: "bg-amber-500/10 text-amber-600",
  revoked: "bg-muted text-muted-foreground", error: "bg-destructive/10 text-destructive",
};

// "Apps connected" — the connected rows from the certified delegatedOAuth `list` action, with
// the empty state and the per-row Refresh / Disconnect actions. Presentational only: every
// action is handed in by the tab, which keeps the certified contract calls.
export default function ConnectedAppsSection({ connected, busy, onRefresh, onDisconnect }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Apps connected</h3>
      </div>
      {connected === null ? (
        <div className="text-muted-foreground py-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : connected.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground/60 py-8 text-center rounded-lg border border-border border-dashed">
          No apps connected yet
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {connected.map((c) => (
            <li key={c.credential_id} className="px-3 py-2.5 flex items-center gap-3">
              <ConnectorIcon name={c.provider_id} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span className="font-medium">{c.provider_id}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[c.status] || "bg-muted text-muted-foreground"}`}>{c.status}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                  {c.external_subject || c.external_email || "—"}
                  {c.expires_at && <> · expires {new Date(c.expires_at).toLocaleString()}</>}
                </div>
              </div>
              <button onClick={() => onRefresh(c.credential_id)} disabled={busy === c.credential_id} title="Refresh" className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                {busy === c.credential_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => onDisconnect(c.credential_id)} disabled={busy === c.credential_id} title="Disconnect" className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}