import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  MessageSquare, Plus, Crown, RefreshCw,
  History, PanelRight, Loader2,
} from "lucide-react";
import ViewPillBar from "./ViewPillBar";
import { base44 } from "@/api/base44Client";
import RoutePicker from "./RoutePicker";
import DevicePicker from "./DevicePicker";
import BranchSelector from "./BranchSelector";
import BuilderOverflowMenu from "./BuilderOverflowMenu";
import BuilderLogoMenu from "./BuilderLogoMenu";
import CollaboratorPopover from "./CollaboratorPopover";

const iconBtn =
  "grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors";

// One unified top bar spanning the full workspace width. The left segment holds the project
// identity + branch controls and is pinned to the chat column's width (var(--chat-w)); the
// right segment holds the preview/canvas controls. Below this bar, the preview SCREEN lives
// in its own separate floating panel — the header is NOT part of that panel.
export default function UnifiedBuilderHeader({
  project, onView, onBranchSwitched,
  chatCollapsed, onToggleCollapse, chatOpen, onToggleChat,
  historyOpen, onToggleHistory,
  envs, liveUrls, onAction,
  view, onEdit, onOpenPages,
  building, activityCount,
  viewport, onViewport, onRefresh, pages, onSelectRoute, picker, onTogglePicker,
  onPublish, publishing, onUpgrade,
}) {
  const [user, setUser] = useState(null);
  const [collabOpen, setCollabOpen] = useState(false);
  const collabRef = useRef(null);

  useEffect(() => { base44.auth.me().then(setUser).catch(() => setUser(null)); }, []);

  useEffect(() => {
    if (!collabOpen) return;
    const handler = (e) => { if (collabRef.current && !collabRef.current.contains(e.target)) setCollabOpen(false); };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [collabOpen]);

  const pathText = project?.id ? `/projects/${project.id.slice(0, 11)}…` : "/projects/…";

  return (
    <header className="h-10 shrink-0 border-b border-border bg-background flex items-stretch relative z-30">
      {/* Left segment — project identity + branch, aligned with the chat column width.
          Hidden in lockstep with the chat column (mobile / collapsed). */}
      <div
        className={`${chatOpen ? "flex" : "hidden"} ${chatCollapsed ? "lg:hidden" : "lg:flex"} items-center gap-1.5 px-2.5 shrink-0`}
        style={{ width: "var(--chat-w)" }}
      >
        <Link to="/" aria-label="Home" className="italic font-bold text-[15px] tracking-tight text-foreground hover:opacity-80 transition-opacity shrink-0">
          nexus.
        </Link>
        <span className="text-muted-foreground/40 text-[12px] select-none" aria-hidden>/</span>
        <BuilderLogoMenu />
        <span className="text-muted-foreground/40 text-[12px] select-none" aria-hidden>/</span>
        <span className="hidden xl:inline font-medium tracking-tight truncate text-[12.5px] max-w-[110px]" title={project?.name}>{project?.name}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <BranchSelector project={project} envs={envs} liveUrls={liveUrls} onMain={() => onView("preview")} onSwitched={onBranchSwitched} onActivity={() => onAction?.("activity")} />
          <button onClick={onToggleHistory} aria-label="Version history" title="Version history" className={iconBtn + (historyOpen ? " bg-muted text-foreground" : "")}>
            <History className="h-4 w-4" />
          </button>
          <button
            onClick={onToggleCollapse}
            aria-label={chatCollapsed ? "Show builder panel" : "Hide builder panel"}
            title={chatCollapsed ? "Show builder panel" : "Hide builder panel"}
            className={iconBtn + (chatCollapsed ? " bg-muted text-foreground" : "")}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Right segment — canvas controls (view pills, device, address, actions, Publish). */}
      <div className="flex-1 min-w-0 flex items-center gap-2 px-3 relative">
        <ViewPillBar
          view={view}
          onView={onView}
          onEdit={onEdit}
          picker={picker}
          onTogglePicker={onTogglePicker}
          onOpenPages={onOpenPages}
        />

        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 min-w-0">
          <DevicePicker viewport={viewport} onViewport={onViewport} />
          <div className="flex items-center gap-1.5 h-7 rounded-full border border-border bg-background pl-1 pr-2.5 text-[11px] text-muted-foreground min-w-0">
            <button
              onClick={onRefresh}
              aria-label="Refresh preview"
              title="Refresh the preview"
              className="grid place-items-center h-5 w-5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
            <RoutePicker pages={pages} pathText={pathText} onSelect={onSelectRoute} />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <BuilderOverflowMenu onAction={onAction} building={building} activityCount={activityCount} projectId={project?.id} />
          <div ref={collabRef} className="relative">
            <button onClick={() => setCollabOpen((o) => !o)} aria-label="Invite collaborators" title="Invite collaborators" className={iconBtn + " border border-border"}>
              <Plus className="h-4 w-4" />
            </button>
            {collabOpen && (
              <CollaboratorPopover
                projectId={project?.id}
                workspaceId={project?.workspace_id}
                branchLabel="Main"
                onClose={() => setCollabOpen(false)}
              />
            )}
          </div>
          <button
            onClick={onToggleChat}
            aria-label="Comments"
            title="Comments and assistant"
            className={iconBtn + (chatOpen ? " bg-muted text-foreground" : "")}
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <Link
            to="/settings"
            aria-label="Account"
            title={user?.email || "Account"}
            className="grid place-items-center h-7 w-7 rounded-full bg-muted text-foreground text-[10.5px] font-semibold hover:bg-accent transition-colors"
          >
            {user ? (user.full_name || user.email || "?").charAt(0).toUpperCase() : "·"}
          </Link>
          <button
            type="button"
            onClick={onUpgrade}
            title="Upgrade your plan"
            className="flex items-center gap-1 h-7 px-2 rounded-md text-[12px] font-medium text-amber-600 hover:text-amber-500 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
          >
            <Crown className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Upgrade</span>
          </button>
          <button
            onClick={onPublish}
            disabled={publishing}
            className="btn-blue-shimmer flex items-center gap-1.5 h-7 rounded-md text-white px-3 text-[12px] font-medium hover:brightness-110 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-[filter]"
          >
            {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Publish
          </button>
        </div>
      </div>
    </header>
  );
}