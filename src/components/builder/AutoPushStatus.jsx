import React from "react";
import { ArrowUpFromLine } from "lucide-react";

// PA-12 status: the latest automatic push, read from the existing GitSyncRun history.
const LABEL = {
  AUTO_PUSH_SKIPPED_PLAN: "Skipped — plan",
  AUTO_PUSH_NO_CREDENTIAL: "Blocked — relink needed",
  AUTO_PUSH_PLAN_UNAVAILABLE: "Blocked — plan unavailable",
  AUTO_PUSH_DEFERRED: "Waiting for another operation",
};

export default function AutoPushStatus({ runs }) {
  const last = (runs || []).find((r) => r.auto);
  const state = !last ? "No automatic push yet" : LABEL[last.failure_code]
    || (last.status === "COMPLETED" ? "Pushed" : ["FAILED", "STALE"].includes(last.status) ? "Failed" : last.status === "CANCELLED" ? "Cancelled" : "In progress");
  return (
    <div className="rounded-lg border border-border p-4 space-y-1">
      <div className="flex items-center gap-2">
        <ArrowUpFromLine className="h-4 w-4 text-muted-foreground" />
        <p className="font-medium">Automatic push</p>
        <span className="ml-auto text-[11px] text-muted-foreground">{state}{last?.version_number != null ? ` · v${last.version_number}` : ""}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">Each saved version is pushed to the linked branch. A diverged branch is never overwritten.</p>
      {last?.failure_summary && last.status !== "COMPLETED" && <p className="text-[11px] text-destructive">{last.failure_summary}</p>}
    </div>
  );
}