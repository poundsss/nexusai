import React from "react";
import { Loader2, XCircle } from "lucide-react";
import DeploymentRow from "@/components/builder/DeploymentRow";
import EnvironmentCard from "@/components/builder/EnvironmentCard";
import DomainsPane from "@/components/builder/DomainsPane";
import SeoChecklist from "@/components/builder/SeoChecklist";
import SocialContent from "@/components/builder/SocialContent";
import MarketingPlanCard from "@/components/builder/MarketingPlanCard";
import GoogleAdsCard from "@/components/builder/GoogleAdsCard";
import ActionPlan from "@/components/builder/ActionPlan";
import MetricsTracking from "@/components/builder/MetricsTracking";

// Deploy is always an explicit, user-authorized action — nothing on this platform
// (including agents) can push a project to production on the user's behalf.
export default function DeployPane({ projectId, versions, deployments, deploy, domains, loading, working, onDeploy, onPromote, onRollback, onCancel, onFixWithAI }) {
  const latest = versions[0] || null;
  const activeDomains = domains.domains.filter((d) => d.status === "active");
  const stgV = deploy.live.staging?.version_number ?? null;
  const prodV = deploy.live.production?.version_number ?? null;
  const drift = stgV != null && prodV != null ? stgV - prodV : null;

  return (
    <div className="h-full overflow-auto p-5 scrollbar-thin">
      <div className="max-w-2xl space-y-4">
        {/* Environment comparison: where each pipeline stands relative to the other */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px]">
          <span className="text-muted-foreground">Comparison</span>
          <span className="font-mono">staging {stgV != null ? "v" + stgV : "—"}</span>
          <span className="text-muted-foreground/40">→</span>
          <span className="font-mono">production {prodV != null ? "v" + prodV : "—"}</span>
          {drift > 0 && <span className="text-amber-600">staging is {drift} version{drift > 1 ? "s" : ""} ahead</span>}
          {drift < 0 && <span className="text-blue-600">production is {-drift} version{drift < -1 ? "s" : ""} ahead</span>}
          {drift === 0 && <span className="text-emerald-600">in sync</span>}
        </div>
        <EnvironmentCard
          environment="staging"
          live={deploy.live.staging}
          active={deploy.active.staging}
          latest={latest}
          versions={versions}
          domains={activeDomains.filter((d) => d.environment === "staging")}
          deployments={deployments.filter((d) => (d.environment || "production") === "staging")}
          working={working}
          onDeploy={onDeploy}
          onRollback={onRollback}
        />
        <EnvironmentCard
          environment="production"
          live={deploy.live.production}
          active={deploy.active.production}
          latest={latest}
          versions={versions}
          domains={activeDomains.filter((d) => d.environment === "production")}
          deployments={deployments.filter((d) => (d.environment || "production") === "production")}
          working={working}
          onDeploy={onDeploy}
          onPromote={onPromote}
          onRollback={onRollback}
        />

        {/* SEO & GEO checklist over the certified SeoScan surface (free, synchronous). */}
        {projectId && <SeoChecklist projectId={projectId} onFixWithAI={onFixWithAI} />}

        {/* Social content (Slice 1): generation + editing only — no sharing, no persistence. */}
        {projectId && <SocialContent projectId={projectId} />}

        {/* Marketing plan (Slice 1): read-only card over the persisted, project-scoped plan. */}
        {projectId && <MarketingPlanCard projectId={projectId} />}

        {/* Google Ads (Marketing entry): Get started / New Campaign, the account card, the
            launch wizard over launch_readiness, and Cancel all — over the certified googleAds
            surface. Launch stays fail-closed until the provider infrastructure exists. */}
        {projectId && <GoogleAdsCard projectId={projectId} />}

        {/* Action plan (Slice 2): items derived from the persisted plan; done/dismiss/reopen
            persist, generate posts is the documented 10-credit action, Send to Builder prefills
            the chat draft (never auto-submits). */}
        {projectId && <ActionPlan projectId={projectId} onFixWithAI={onFixWithAI} />}

        {/* Metrics tracking: read-only current values derived on demand from the project's
            existing analytics events (7/30-day windows, retention-clamped horizon). No
            history, no refresh, no credits. */}
        {projectId && <MetricsTracking projectId={projectId} />}

        <DomainsPane
          projectId={projectId}
          onChanged={domains.reload}
          domains={domains.domains}
          loading={domains.loading}
          working={domains.working}
          onAdd={domains.add}
          onVerify={domains.verify}
          onSetPrimary={domains.setPrimary}
          onRemove={domains.remove}
        />

        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Deployment history</h3>
          <div className="mt-3 space-y-2">
            {loading && <div className="text-[12px] text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>}
            {!loading && deploy.error && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-[11.5px] text-destructive">
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">Deployment history could not be loaded. {deploy.error}</span>
                <button onClick={deploy.reload} disabled={loading} className="shrink-0 underline hover:text-foreground/80 transition-colors disabled:opacity-50">Retry</button>
              </div>
            )}
            {!loading && !deployments.length && !deploy.error && <p className="text-[12px] text-muted-foreground/60">No deployments yet.</p>}
            {deployments.map((d) => (
              <DeploymentRow
                key={d.id}
                deployment={d}
                isCurrent={d.id === deploy.live[d.environment || "production"]?.id}
                onRollback={onRollback}
                onCancel={onCancel}
                working={working}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}