import React, { useState } from "react";
import { Rocket, Loader2, ExternalLink, ShieldCheck, ArrowUpRight, RotateCcw } from "lucide-react";

// One environment's live state. Staging and production are independent pipelines: deploying
// here never changes the other, and promotion ships the exact artifact already verified.
// Any RESTORED version can be deployed, not just the latest — the selector pins the exact
// version the deployment will build its immutable artifact from.
export default function EnvironmentCard({ environment, live, active, latest, versions = [], deployments = [], domains = [], working, onDeploy, onPromote, onRollback }) {
  const isProd = environment === "production";
  const [versionId, setVersionId] = useState("");
  const target = versions.find((v) => v.id === versionId) || latest;
  const behind = live && target ? target.number - live.version_number : 0;
  // Rollback targets: previous LIVE deployments of THIS environment. History is never
  // rewritten — a rollback creates a new deployment of the old immutable artifact.
  const [rollbackId, setRollbackId] = useState("");
  const rollbackTargets = (deployments || []).filter((d) => (d.environment || "production") === environment && d.status === "LIVE" && d.id !== live?.id);

  return (
    <div className={`rounded-md border p-4 ${isProd ? "border-border" : "border-border bg-muted/30"}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold tracking-tight capitalize">{environment}</h2>
            {active && <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-600"><Loader2 className="h-3 w-3 animate-spin" />{active.status}</span>}
          </div>
          {live ? (
            <>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Serving <span className="font-mono">version {live.version_number}</span>
                {behind > 0 && <span className="text-amber-600"> · {behind} version{behind > 1 ? "s" : ""} ahead not deployed</span>}
              </p>
              <a href={live.deployment_url} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-[12px] text-blue-600 hover:underline">
                {live.deployment_url}<ExternalLink className="h-3 w-3" />
              </a>
              {domains.map((d) => (
                <a key={d.id} href={`https://${d.hostname}`} target="_blank" rel="noreferrer" className="mt-1 block font-mono text-[12px] text-blue-600 hover:underline">
                  {d.hostname}{d.is_primary ? " · primary" : ""}
                </a>
              ))}
              {live.secret_scan === "pass" && (
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-emerald-600"><ShieldCheck className="h-3.5 w-3.5" />No credentials in the deployed bundle</p>
              )}
            </>
          ) : (
            <p className="mt-1 text-[12px] text-muted-foreground">
              {isProd
                ? "Not deployed yet. Preview changes never affect production — deploying is always explicit."
                : "Nothing in staging yet. Staging is a separate environment with its own data-free URL."}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 items-end">
          {versions.length > 0 && (
            <select
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              aria-label="Version to deploy"
              className="max-w-[200px] rounded-md border border-border bg-background px-2 py-1 text-[11.5px] text-muted-foreground"
            >
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.number} — {v.message}</option>)}
            </select>
          )}
          <button
            onClick={() => onDeploy(environment, target?.id)}
            disabled={working || !target || !!active}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
            Deploy{target ? ` v${target.number}` : ""}
          </button>
          {isProd && (
            <button
              onClick={onPromote}
              disabled={working || !!active}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              title="Ship the exact artifact staging already verified — no rebuild"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />Promote staging
            </button>
          )}
          {live && rollbackTargets.length > 0 && (
            <div className="flex items-center gap-1.5">
              <select
                value={rollbackId}
                onChange={(e) => setRollbackId(e.target.value)}
                aria-label="Rollback target"
                className="max-w-[200px] rounded-md border border-border bg-background px-2 py-1 text-[11.5px] text-muted-foreground"
              >
                {rollbackTargets.map((d) => <option key={d.id} value={d.id}>v{d.version_number}</option>)}
              </select>
              <button
                onClick={() => onRollback(rollbackId || rollbackTargets[0].id, environment)}
                disabled={working || !!active}
                title="Roll this environment back to the selected version's artifact"
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />Roll back
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}