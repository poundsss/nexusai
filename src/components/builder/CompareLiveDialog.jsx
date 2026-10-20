import React from "react";
import { X, GitCompareArrows } from "lucide-react";
import VersionDiffPanel from "./VersionDiffPanel";

// "Compare with live code": the immutable live PRODUCTION version against the latest
// committed version, through the same versionDiff contract the Versions pane uses.
export default function CompareLiveDialog({ projectId, liveVersion, latestVersion, onClose }) {
  const upToDate = liveVersion && latestVersion && liveVersion.id === latestVersion.id;
  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl border border-border bg-background shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <GitCompareArrows className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-[13px]">Compare with live code</h3>
          <button onClick={onClose} className="ml-auto grid place-items-center h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto scrollbar-thin">
          {!liveVersion ? (
            <p className="p-4 text-[12.5px] text-muted-foreground">Production is not deployed yet — there is no live version to compare against.</p>
          ) : upToDate ? (
            <p className="p-4 text-[12.5px] text-muted-foreground">
              {"Live production (v" + liveVersion.number + ") is the latest version — the deployed code matches history."}
            </p>
          ) : (
            <VersionDiffPanel projectId={projectId} fromVersionId={liveVersion.id} toVersionId={latestVersion.id} />
          )}
        </div>
      </div>
    </div>
  );
}