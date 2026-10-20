import React, { useState } from "react";
import { Github, ArrowUpFromLine, ArrowDownToLine, Loader2, Unlink, LogOut, Webhook, Bell, BellOff } from "lucide-react";
import GitLinkForm from "@/components/builder/GitLinkForm";
import GitSyncRow from "@/components/builder/GitSyncRow";
import AutoPushStatus from "@/components/builder/AutoPushStatus";

// GitHub is an external source layer, never the runtime source of truth: an import lands as
// a new internal version that still has to be deployed explicitly to reach production.
export default function GitHubPane({ github, versions, onExport, onImport }) {
  const [versionId, setVersionId] = useState("");
  const [sha, setSha] = useState("");
  const link = github.link;
  const linked = link && link.status !== "disconnected";

  if (github.loading) return <div className="h-full grid place-items-center text-muted-foreground/60"><Loader2 className="h-4 w-4 animate-spin" /></div>;

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Github className="h-4 w-4" />
        <h2 className="font-semibold tracking-tight">Source control</h2>
        {github.account && <span className="text-[11px] text-muted-foreground font-mono">@{github.account.login}</span>}
        {github.connected && (
          <button onClick={github.disconnect} disabled={github.working} className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
            <LogOut className="h-3 w-3" />Disconnect GitHub
          </button>
        )}
      </div>

      {!github.connected && (
        <div className="rounded-lg border border-border p-4">
          <p className="font-medium">{github.tokenInvalid ? "Reconnect GitHub" : "Connect GitHub"}</p>
          <p className="mt-1 text-muted-foreground">
            {github.tokenInvalid
              ? "GitHub no longer accepts your authorization — it was revoked or has expired. Reconnect your account to continue."
              : "You authorize your own GitHub account — each user of NexusAI connects their own, and no one acts through anyone else's. Your token is never stored in project data."}
          </p>
          {github.connectError && <p className="mt-1.5 text-[11px] text-destructive">{github.connectError}</p>}
          <button onClick={github.connect} className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90 transition-colors"><Github className="h-3.5 w-3.5" />{github.tokenInvalid ? "Reconnect GitHub" : "Connect GitHub"}</button>
        </div>
      )}

      {github.connected && !linked && <GitLinkForm github={github} onDone={github.reload} />}

      {github.connected && linked && (
        <>
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono">{link.repo_full_name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">{link.branch}</span>
              {link.subdirectory && <span className="text-[11px] text-muted-foreground font-mono">/{link.subdirectory}</span>}
              <button onClick={github.unlink} className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"><Unlink className="h-3 w-3" />Unlink</button>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground font-mono">
              {link.last_export_commit_sha && <span>last export {link.last_export_commit_sha.slice(0, 7)} ← v{link.last_export_version_number}</span>}
              {link.last_import_commit_sha && <span>last import {link.last_import_commit_sha.slice(0, 7)} → v{link.last_import_version_number}</span>}
              {link.last_sync_at && <span>synced {new Date(link.last_sync_at).toLocaleString()}</span>}
            </div>
            {link.last_error && <p className="mt-1.5 text-[11px] text-destructive">{link.last_error}</p>}
            {!github.linkIsYours && (
              <p className="mt-1.5 text-[11px] text-amber-600">
                Linked with {link.connected_login ? `@${link.connected_login}` : "another user's"} GitHub account. Exports and imports are unavailable to you — connect your own account and relink to use it.
              </p>
            )}
          </div>

          {github.linkIsYours && (
            <div className="rounded-lg border border-border p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Webhook className="h-3.5 w-3.5" />
                <p className="font-medium">Auto-import on push</p>
                <span className={`ml-auto inline-flex items-center gap-1 text-[11px] ${github.webhook?.active ? "text-emerald-600" : "text-muted-foreground"}`}>
                  {github.webhook?.active ? <><Bell className="h-3 w-3" />Active</> : <><BellOff className="h-3 w-3" />Off</>}
                </span>
              </div>
              <p className="text-muted-foreground">
                {github.webhook?.active
                  ? "Pushes to the linked branch are automatically imported as new internal versions after build and security validation."
                  : "Register a webhook so pushes to the linked branch are automatically imported."}
              </p>
              {github.webhook?.active && github.webhook.last_delivery_at && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground font-mono">
                  <span>last delivery {new Date(github.webhook.last_delivery_at).toLocaleString()}</span>
                  {github.webhook.last_delivery_status && <span>status: {github.webhook.last_delivery_status}</span>}
                  {github.webhook.last_delivery_id && <span>id {github.webhook.last_delivery_id.slice(0, 8)}</span>}
                </div>
              )}
              {github.webhook?.last_error && <p className="text-[11px] text-destructive">{github.webhook.last_error}</p>}
              <div className="flex gap-2 pt-1">
                {!github.webhook?.active ? (
                  <button onClick={github.registerWebhook} disabled={github.working} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">Register webhook</button>
                ) : (
                  <button onClick={github.removeWebhook} disabled={github.working} className="rounded-md border border-border px-3 py-1.5 text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50">Remove webhook</button>
                )}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-4 space-y-2">
              <p className="font-medium flex items-center gap-1.5"><ArrowUpFromLine className="h-3.5 w-3.5" />Export to GitHub</p>
              <select value={versionId} onChange={(e) => setVersionId(e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[12px]">
                <option value="">Latest version (v{versions[0]?.number})</option>
                {versions.map((v) => <option key={v.id} value={v.id}>v{v.number} — {String(v.message || "").slice(0, 44)}</option>)}
              </select>
              <button onClick={() => onExport(versionId || undefined)} disabled={github.working || !github.linkIsYours} className="w-full rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">Export version</button>
            </div>

            <div className="rounded-lg border border-border p-4 space-y-2">
              <p className="font-medium flex items-center gap-1.5"><ArrowDownToLine className="h-3.5 w-3.5" />Import from GitHub</p>
              <input value={sha} onChange={(e) => setSha(e.target.value)} placeholder={`Commit SHA (blank = ${link.branch} head)`} className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]" />
              <button onClick={() => onImport(sha.trim() || undefined)} disabled={github.working || !github.linkIsYours} className="w-full rounded-md border border-border px-3 py-1.5 hover:bg-muted transition-colors disabled:opacity-50">Import commit</button>
              <p className="text-[11px] text-muted-foreground">Creates a new internal version after build and security validation. Never deploys.</p>
            </div>
          </div>

          {!!github.commitMap.length && (
            <div className="rounded-lg border border-border p-4">
              <p className="font-medium">Commit ↔ version map</p>
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
                {github.commitMap.slice(0, 8).map((m) => (
                  <li key={`${m.commit_sha}-${m.version_id}-${m.direction}`} className="flex items-center gap-2">
                    <span className="text-muted-foreground/60">{m.direction === "export" ? "→" : "←"}</span>
                    <span>{m.commit_sha.slice(0, 7)}</span>
                    <span className="text-muted-foreground/60">↔</span>
                    <span>v{m.version_number}</span>
                    <span className="text-muted-foreground/60">{m.branch}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <AutoPushStatus runs={github.runs} />

          <div className="space-y-2">
            <p className="font-medium">Operations</p>
            {github.runs.length === 0 && <p className="text-muted-foreground">No GitHub operations yet.</p>}
            {github.runs.map((r) => <GitSyncRow key={r.id} run={r} onCancel={github.cancel} />)}
          </div>
        </>
      )}
    </div>
  );
}