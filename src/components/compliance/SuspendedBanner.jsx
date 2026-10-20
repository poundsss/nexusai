import React from "react";
import { ShieldAlert, LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";

// Shown when the workspace is suspended. Provides a restricted-access experience without
// breaking security — the backend still rejects every write; this just explains why.
export default function SuspendedBanner({ workspaceName, onAppeal }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <ShieldAlert className="h-6 w-6 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold text-[15px] text-destructive">Workspace suspended</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {workspaceName ? `"${workspaceName}" is ` : "This workspace is "}suspended. Most actions are restricted while we review the account. If you believe this is an error, you can submit an appeal.
          </p>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={onAppeal}>
              <LifeBuoy className="h-3.5 w-3.5 mr-1.5" />Submit an appeal
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}