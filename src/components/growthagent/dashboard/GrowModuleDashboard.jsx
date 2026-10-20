import React, { useState } from "react";
import { ArrowLeft, RefreshCw, Search, Target } from "lucide-react";
import GrowProjectPicker from "../GrowProjectPicker";
import AdsDash from "./AdsDash";
import SocialDash from "./SocialDash";
import OutreachDash from "./OutreachDash";
import ListeningDash from "./ListeningDash";
import OrganicDash from "./OrganicDash";
import BusinessDash from "./BusinessDash";
import GrowLegacyModuleDashboard from "./GrowLegacyModuleDashboard";
import GrowModuleDetail from "./GrowModuleDetail";
import { StateNote } from "./dashBits";

// Certified six-module panels — modules OUTSIDE the screenshot's five keep their existing
// shell and behavior, unchanged.
const CERTIFIED_PANELS = {
  running_ads: AdsDash,
  social_media: SocialDash,
  cold_outreach: OutreachDash,
  social_listening: ListeningDash,
  organic_growth: OrganicDash,
  my_business: BusinessDash,
};

// The Grow · Module Dashboard from the reference screenshot: a compact two-column module grid
// (Google Ads, Meta Ads, Email, Cold Calling, TikTok Ads), a divider, then the selected
// module's own certified detail. Every module reads through the EXISTING certified surfaces;
// nothing here launches, spends, sends or dials.
const MODULES = [
  { id: "google_ads", label: "Google Ads", icon: Search },
  { id: "meta_ads", label: "Meta Ads", icon: Target },
];

export default function GrowModuleDashboard({ module, workspace, projectId, onProjectChange, onBack, onConfigure }) {
  const legacy = module && CERTIFIED_PANELS[module.id] && !MODULES.some((m) => m.id === module.id);
  const [selected, setSelected] = useState(() => (module && MODULES.some((m) => m.id === module.id) ? module.id : "google_ads"));
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = () => setReloadKey((k) => k + 1);

  if (legacy) {
    return (
      <GrowLegacyModuleDashboard
        module={module} workspace={workspace} projectId={projectId} onProjectChange={onProjectChange}
        onBack={onBack} onConfigure={onConfigure} Panel={CERTIFIED_PANELS[module.id]} reloadKey={reloadKey} onRefresh={refresh}
      />
    );
  }

  const active = MODULES.find((m) => m.id === selected) || MODULES[0];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 pt-5 pb-10 sm:px-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-accent">
            <ArrowLeft className="h-3.5 w-3.5" /> Grow
          </button>
          <button type="button" onClick={refresh} title="Refresh — same identity, same history"
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <h1 className="mt-4 text-[19px] font-semibold tracking-tight text-foreground">Статистика рекламы</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Как идут ваши кампании.</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={onProjectChange} />
        </div>

        {/* Two-column module grid — the selected tile is subtly highlighted. */}
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MODULES.map((m) => (
            <button key={m.id} type="button" onClick={() => setSelected(m.id)} aria-pressed={m.id === active.id}
              className={`flex flex-col items-start gap-1.5 rounded-xl border px-3.5 py-3 text-left transition-colors ${m.id === active.id ? "border-foreground/25 bg-accent" : "border-border bg-card hover:bg-accent/60"}`}>
              <m.icon className="h-4 w-4 text-foreground" />
              <span className="text-[13.5px] font-semibold text-foreground">{m.label}</span>
            </button>
          ))}
        </div>

        <div className="my-5 h-px bg-border" />

        {projectId
          ? <GrowModuleDetail key={`${active.id}:${projectId}:${reloadKey}`} moduleId={active.id} projectId={projectId} onConfigure={onConfigure} />
          : <StateNote tone="empty" title="Select a project" detail="Every dashboard read is project-scoped — pick the project this module belongs to." />}
      </div>
    </div>
  );
}