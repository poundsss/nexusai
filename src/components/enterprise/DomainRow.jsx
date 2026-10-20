import React, { useState } from "react";
import { Globe, Loader2, Check, X, Copy, Trash2, RefreshCw } from "lucide-react";

const STATUS_STYLES = {
  pending: { cls: "bg-amber-500/10 text-amber-600", label: "Pending" },
  verified: { cls: "bg-emerald-500/10 text-emerald-600", label: "Verified" },
  failed: { cls: "bg-destructive/10 text-destructive", label: "Failed" },
};

// One verified domain. The verification token is the TXT record value the org must publish.
// Verification is a real DNS check on the backend — the UI never claims a domain is verified
// unless the backend status says so.
export default function DomainRow({ domain, onVerify, onRemove, working }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [records, setRecords] = useState("");
  const [showVerify, setShowVerify] = useState(false);
  const [error, setError] = useState(null);
  const style = STATUS_STYLES[domain.status] || { cls: "bg-muted text-muted-foreground", label: domain.status };

  const copyToken = () => navigator.clipboard.writeText(domain.verification_token);

  const doVerify = async () => {
    setError(null);
    const txtRecords = records.trim().split("\n").map((r) => r.trim()).filter(Boolean);
    try {
      await onVerify(domain.id, txtRecords);
      setShowVerify(false);
      setRecords("");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-3">
        <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-mono text-[13px] font-medium flex-1 truncate">{domain.domain}</span>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.cls}`}>
          {style.label}
        </span>
        {domain.status === "verified" && domain.verified_at && (
          <span className="text-[11px] text-muted-foreground whitespace-nowrap">{new Date(domain.verified_at).toLocaleDateString()}</span>
        )}
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={working}
          className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
          title="Remove domain"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {domain.status !== "verified" && (
        <div className="mt-3 space-y-2">
          <div className="rounded-md bg-muted/50 p-2.5 text-[12px]">
            <p className="text-muted-foreground">Publish a TXT record at <code className="font-mono text-foreground">_nexusai-verify.{domain.domain}</code> with this value:</p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-background border border-border px-2 py-1 text-[11px] font-mono">{domain.verification_token}</code>
              <button onClick={copyToken} className="text-muted-foreground hover:text-foreground transition-colors shrink-0" title="Copy token"><Copy className="h-3.5 w-3.5" /></button>
            </div>
          </div>
          {!showVerify ? (
            <button onClick={() => setShowVerify(true)} className="inline-flex items-center gap-1.5 text-[12px] text-primary hover:underline">
              <RefreshCw className="h-3.5 w-3.5" />Verify now
            </button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={records}
                onChange={(e) => setRecords(e.target.value)}
                placeholder={"Paste the TXT record values returned by your DNS lookup, one per line:\n" + domain.verification_token}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-[11px]"
              />
              <div className="flex items-center gap-2">
                <button onClick={doVerify} disabled={working} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Check verification
                </button>
                <button onClick={() => setShowVerify(false)} className="text-[12px] text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
              {error && <p className="text-[12px] text-destructive">{error}</p>}
            </div>
          )}
        </div>
      )}

      {confirmOpen && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-[12px]">
          <span className="flex-1 text-destructive">Remove this domain? SSO routing for its users stops immediately.</span>
          <button onClick={async () => { await onRemove(domain.id); setConfirmOpen(false); }} disabled={working} className="rounded-md bg-destructive px-2.5 py-1 text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">Remove</button>
          <button onClick={() => setConfirmOpen(false)} className="text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}
    </div>
  );
}