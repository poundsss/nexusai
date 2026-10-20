import React from "react";
import DashModuleTools from "./DashModuleTools";
import DashChannelStatus from "./DashChannelStatus";

export default function DashConnections({ channels, projectId, onChanged, onConfigure }) {
  return (
    <section className="rounded-lg border border-border bg-card px-3 py-2">
      <h2 className="pt-1 pb-1 text-[14px] font-semibold text-foreground">Connections</h2>
      <p className="pb-1 text-[11.5px] text-muted-foreground">Ad accounts for this project</p>
      <DashChannelStatus channels={channels} projectId={projectId} onChanged={onChanged} />
      <DashModuleTools onConfigure={onConfigure} />
    </section>
  );
}