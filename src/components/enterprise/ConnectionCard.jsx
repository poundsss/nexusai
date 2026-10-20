import React, { useState } from "react";
import { ShieldCheck, KeyRound, Loader2, Power, Copy } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";

const PROTOCOL_ICON = { saml: ShieldCheck, oidc: KeyRound };

// One SSO connection. Shows the safe projection (safeConnection) — never the encrypted cert
// or secret. The fingerprint and has_cert/has_secret booleans are the only artifacts of the
// stored secrets, so the user can confirm a secret exists without ever seeing it.
export default function ConnectionCard({ connection, onDisable, working }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const Icon = PROTOCOL_ICON[connection.protocol] || ShieldCheck;
  const active = connection.status === "active";

  const copySignInUrl = () => navigator.clipboard.writeText(connection.sign_in_url || "");

  return (
    <div className={`rounded-lg border p-4 ${active ? "border-border" : "border-border bg-muted/30"}`}>
      <div className="flex items-start gap-3">
        <span className={`h-9 w-9 rounded-lg grid place-items-center shrink-0 ${active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[14px] truncate">{connection.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">{connection.protocol}</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${active ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
              {active ? "Active" : "Disabled"}
            </span>
          </div>
          {connection.protocol === "saml" && (
            <div className="mt-1.5 space-y-0.5 text-[12px] text-muted-foreground">
              <p>Entity ID: <span className="font-mono text-foreground">{connection.saml_entity_id || "—"}</span></p>
              {connection.saml_acs_url && <p>ACS URL: <span className="font-mono text-foreground">{connection.saml_acs_url}</span></p>}
              <p>Certificate: {connection.has_cert ? <span className="text-emerald-600">stored (fingerprint {connection.saml_cert_fingerprint?.slice(0, 16)}…)</span> : <span className="text-destructive">missing</span>}</p>
            </div>
          )}
          {connection.protocol === "oidc" && (
            <div className="mt-1.5 space-y-0.5 text-[12px] text-muted-foreground">
              <p>Issuer: <span className="font-mono text-foreground">{connection.oidc_issuer || "—"}</span></p>
              <p>Client ID: <span className="font-mono text-foreground">{connection.oidc_client_id || "—"}</span></p>
              <p>Secret: {connection.has_secret ? <span className="text-emerald-600">stored (encrypted)</span> : <span className="text-destructive">missing</span>}</p>
              {connection.oidc_scopes?.length > 0 && <p>Scopes: <span className="font-mono text-foreground">{connection.oidc_scopes.join(" ")}</span></p>}
            </div>
          )}
          {connection.sign_in_url && (
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-[11px] font-mono">{connection.sign_in_url}</code>
              <button onClick={copySignInUrl} className="text-muted-foreground hover:text-foreground transition-colors" title="Copy sign-in URL"><Copy className="h-3.5 w-3.5" /></button>
            </div>
          )}
          {connection.last_used_at && <p className="mt-1.5 text-[11px] text-muted-foreground">Last used {new Date(connection.last_used_at).toLocaleString()}</p>}
        </div>
        <div className="shrink-0">
          {active && (
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={working}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              Disable
            </button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disable SSO connection?"
        description="Users on verified domains will no longer be able to sign in through this connection. Password login is still available unless SSO enforcement is enabled."
        confirmLabel="Disable connection"
        working={working}
        onConfirm={async () => { await onDisable(connection.id); setConfirmOpen(false); }}
      />
    </div>
  );
}