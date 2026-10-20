import React from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import GrowProjectPicker from "../GrowProjectPicker";
import { StateNote } from "./dashBits";

// The previous Grow module dashboard shell, preserved verbatim for the six certified Grow
// modules (running_ads, social_media, cold_outreach, social_listening, organic_growth,
// my_business). Their behavior, picker and refresh semantics are unchanged.
export default function GrowLegacyModuleDashboard({ module, workspace, projectId, onProjectChange, onBack, onConfigure, Panel, reloadKey, onRefresh }) {
  if (!Panel) return <StateNote tone="error" title="Unknown module" detail={module.id} />;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 pt-5 pb-10 sm:px-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-accent">
            <ArrowLeft className="h-3.5 w-3.5" /> Grow
          </button>
          <module.icon className="h-4 w-4 text-brand" />
          <p className="text-[14px] font-semibold text-foreground">{module.label}</p>
          <button type="button" onClick={onRefresh} title="Refresh — same identity, same history"
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-4">
          <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={onProjectChange} />
        </div>

        <div className="mt-1">
          {projectId
            ? <Panel projectId={projectId} onConfigure={onConfigure} reloadKey={reloadKey} />
            : <StateNote tone="empty" title="Select a project" detail="Every dashboard read is project-scoped — pick the project this module belongs to." />}
        </div>
      </div>
    </div>
  );
}