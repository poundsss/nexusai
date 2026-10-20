import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Search, LayoutGrid, LayoutTemplate, LayoutDashboard, Star, TrendingUp,
  ChevronsLeft, X, Bot, Workflow, StickyNote,
  Wrench, Video, Settings2, Ellipsis, ChevronDown, Plus,
  FolderOpen, Brain, Database,
} from "lucide-react";
import ModeSwitcher, { isAgentMode, isGrowMode } from "@/components/shell/ModeSwitcher";
import { canSeePath } from "@/lib/navAccess";
import RecentsSection from "@/components/shell/RecentsSection";
import ReferralCard from "@/components/shell/ReferralCard";
import WorkspaceMenu from "@/components/shell/WorkspaceMenu";
import ConversationsSidebar from "@/components/agent/ConversationsSidebar";
import SetupSuperagentCard from "@/components/shell/SetupSuperagentCard";
import GrowDashboardProjects from "@/components/shell/GrowDashboardProjects";
import { requestNewConversation } from "@/lib/agentChatStore";

// PRIMARY navigation matches the confirmed Base44 default main sidebar (Home, All apps,
// Templates, Community) plus the global Search action. Administration and build-tools live only
// in the account / workspace popover, gated by the shared navAccess rules — never duplicated here.
const PRIMARY = [
  { label: "All apps", icon: LayoutGrid, to: "/projects" },
  { label: "Templates", icon: LayoutTemplate, to: "/marketplace" },
];

const FAVORITES = { label: "Favorites", icon: Star, to: "/projects?filter=favorites" };

// The Grow growth workspace (module grid + chat) — a REAL sidebar entry so the certified
// Grow · Module Dashboard is reachable from the sidebar without the mode switcher.
// Ungated (navAccess): the route link opens the EXISTING Grow screen — no new route.
const GROW = { label: "Grow", icon: TrendingUp, to: "/growth-agent" };

// Grow mode keeps a visible entry to its project Dashboard: the SAME /growth-agent route with
// ?dashboard=1 — the existing screen opens its certified project-scoped `grow` rollup instead
// of the chat, for the project selected in the composer. No second dashboard or route.
const GROW_PRIMARY = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/growth-agent?dashboard=1" },
];



// AGENT mode navigation — the reference Agent left bar (one bar: mode switcher, agent nav,
// Conversations). Meetings resolves Google through the certified delegatedOAuth connect flow.
const AGENT_PRIMARY = [
  { label: "Workflows", icon: Workflow, to: "/workflows" },
  { label: "Plugins", icon: Wrench, to: "/plugins" },
  { label: "Meetings", icon: Video, to: "/meetings", title: "Connect Google Calendar & Meet" },
  { label: "Notes", icon: StickyNote, to: "/notes" },
  { label: "Agent Settings", icon: Settings2, to: "/agent/settings" },
];
// Folded extras behind "More" in Agent mode — the reference surface's Files / Memory / Data.
const AGENT_MORE = [
  { label: "Files", icon: FolderOpen, to: "/agent/files" },
  { label: "Memory", icon: Brain, to: "/agent/memory" },
  { label: "Data", icon: Database, to: "/agent/data" },
];

function isActive(pathname, to) {
  const base = to.split("?")[0];
  if (base === "/") return pathname === "/";
  return pathname === base || pathname.startsWith(base + "/");
}

const itemClass = (active, collapsed) =>
  `group relative flex w-full items-center gap-2 rounded-md px-2 py-[6px] text-[13px] transition-colors ${
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
      : "text-sidebar-foreground/70 font-medium hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
  } ${collapsed ? "justify-center" : ""}`;

// A nav item is EITHER a route link or the single search action. The palette opener reaches only
// the search branch, so no link — Home included — can open the command palette.
function NavItem({ item, collapsed, onNavigate, onOpenPalette }) {
  const { pathname } = useLocation();
  const active = item.to ? isActive(pathname, item.to) : false;
  const Icon = item.icon;
  const inner = (
    <>
      {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-3.5 w-[2px] rounded-full bg-foreground" />}
      <Icon className={`h-4 w-4 shrink-0 transition-colors ${active ? "text-foreground" : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80"}`} />
      {!collapsed && <span className="flex-1 truncate text-left">{item.label}</span>}
      {!collapsed && item.badge && (
        <span className="rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-brand-foreground">{item.badge}</span>
      )}
    </>
  );

  if (item.action === "search") {
    return (
      <button type="button" title={collapsed ? item.label : (item.title || undefined)} onClick={() => { onOpenPalette?.(); onNavigate?.(); }} className={itemClass(false, collapsed)}>
        {inner}
      </button>
    );
  }
  return (
    <Link to={item.to} onClick={onNavigate} title={collapsed ? item.label : (item.title || undefined)} className={itemClass(active, collapsed)}>
      {inner}
    </Link>
  );
}

export default function ShellSidebar({
  workspace, user, capabilities, loading, collapsed, onToggleCollapse, mobileOpen, onCloseMobile, onOpenPalette,
  plan, credits, renewalDate, memberCount, recents = [], unread = 0, referralCode = null, entitlements = {},
}) {
  const { pathname } = useLocation();
  const agentMode = isAgentMode(pathname);
  const growMode = isGrowMode(pathname);
  const [agentMoreOpen, setAgentMoreOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e) => { if (e.key === "Escape") onCloseMobile(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mobileOpen, onCloseMobile]);

  // Sidebar visibility mirrors the shared navAccess gate used by WorkspaceMenu and the command
  // palette, so the three surfaces never disagree. The server re-authorizes every request;
  // hiding here only prevents a member from seeing an entry they would get 403 on.
  const accessCtx = { user, capabilities, plan, entitlements };
  const menu = (growMode ? GROW_PRIMARY : agentMode ? AGENT_PRIMARY : PRIMARY).filter(
    (item) => !item.to || canSeePath(item.to, accessCtx)
  );

  const aside = (
    <aside className={`${collapsed ? "w-[52px]" : "w-[224px]"} shrink-0 bg-sidebar flex flex-col transition-[width] duration-200`}>
      {/* Header: brand + collapse */}
      <div className={`h-12 shrink-0 flex items-center gap-2 border-b border-sidebar-border px-3 ${collapsed ? "flex-col justify-center gap-1 py-1" : ""}`}>
        {collapsed ? (
          <>
            <Link to="/" aria-label="Home" className="italic font-bold text-[15px] tracking-tight text-sidebar-foreground leading-none">n.</Link>
            <div className="flex items-center gap-1">
              <button onClick={() => onOpenPalette?.()} aria-label="Search" title="Search" className="grid place-items-center h-5 w-5 rounded-md text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors">
                <Search className="h-3.5 w-3.5" />
              </button>
              <button onClick={onToggleCollapse} aria-label="Expand sidebar" title="Expand" className="grid place-items-center h-5 w-5 rounded-md text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors">
                <ChevronsLeft className="h-3.5 w-3.5 rotate-180" />
              </button>
            </div>
          </>
        ) : (
          <>
            <Link to="/" aria-label="Home" className="flex items-baseline gap-1 shrink-0">
              <span className="italic font-bold text-[15px] tracking-tight text-sidebar-foreground">nexus.</span>
              <span className="text-sidebar-foreground/30 text-[12px] select-none" aria-hidden>/</span>
            </Link>
            <div className="flex-1" />
            <button onClick={() => onOpenPalette?.()} aria-label="Search" title="Search" className="grid place-items-center h-6 w-6 rounded-md text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors">
              <Search className="h-3.5 w-3.5" />
            </button>
            <button onClick={onToggleCollapse} aria-label="Collapse sidebar" className="hidden md:grid place-items-center h-6 w-6 rounded-md text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors">
              <ChevronsLeft className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Mode switcher */}
      <div className="px-2 pt-2 pb-1">
        <ModeSwitcher collapsed={collapsed} onNavigate={onCloseMobile} />
      </div>

      {/* Navigation — the ACTIVE MODE decides which menu exists. Agent mode shows only the agent
          surface plus search, so the Apps menu is never duplicated inside it. */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin px-1.5 py-1.5 space-y-2" aria-label="Main navigation">
        {/* Reference order: "New conversation" is the FIRST agent item, above Workflows. */}
        {agentMode && !collapsed && (
          <button
            type="button"
            onClick={requestNewConversation}
            className={`${itemClass(false, false)} mb-1`}
          >
            <Plus className="h-4 w-4 shrink-0 text-sidebar-foreground/50" />
            <span className="flex-1 truncate text-left">New conversation</span>
          </button>
        )}
        <div className="space-y-0.5">
          {menu.map((item) => (
            <NavItem
              key={item.label}
              item={item}
              collapsed={collapsed}
              onNavigate={onCloseMobile}
              // ONLY Search receives the palette opener.
              onOpenPalette={item.action === "search" ? onOpenPalette : undefined}
            />
          ))}
          {growMode && !collapsed && <GrowDashboardProjects workspaceId={workspace?.id} onNavigate={onCloseMobile} />}
        </div>

        {agentMode && (
          <div className="space-y-0.5">
            {!collapsed && (
              <button
                type="button"
                onClick={() => setAgentMoreOpen((v) => !v)}
                className={itemClass(false, false)}
              >
                <Ellipsis className="h-4 w-4 shrink-0 text-sidebar-foreground/50" />
                <span className="flex-1 truncate text-left">More</span>
                <ChevronDown className={`h-3.5 w-3.5 text-sidebar-foreground/40 transition-transform ${agentMoreOpen ? "rotate-180" : ""}`} />
              </button>
            )}
            {(collapsed || agentMoreOpen) && AGENT_MORE.map((item) => (
              <NavItem key={item.label} item={item} collapsed={collapsed} onNavigate={onCloseMobile} />
            ))}
          </div>
        )}

        {!agentMode && (
          <div className={`space-y-0.5 ${!growMode ? "border-t border-sidebar-border/70 pt-2.5" : ""}`}>
            {!growMode && <NavItem item={FAVORITES} collapsed={collapsed} onNavigate={onCloseMobile} />}
            {/* Grow: visible in the Apps sidebar; hidden in Grow mode itself, where the mode
                switcher already highlights the active Grow surface. */}
            {!growMode && <NavItem item={GROW} collapsed={collapsed} onNavigate={onCloseMobile} />}
            <RecentsSection recents={recents} collapsed={collapsed} onNavigate={onCloseMobile} />
          </div>
        )}

        {/* Agent mode: the Setup Superagent progress card, then the conversation list — both in THIS bar. */}
        {agentMode && !collapsed && (
          <div className="border-t border-sidebar-border/70 pt-2.5">
            <SetupSuperagentCard />
          </div>
        )}
        {agentMode && !collapsed && (
          <div className="border-t border-sidebar-border/70 pt-2.5">
            <ConversationsSidebar />
          </div>
        )}
      </nav>

      {/* Bottom: referral · account/workspace ONLY — credits live inside the account popover */}
      <div className="shrink-0 border-t border-sidebar-border p-2 space-y-1.5">
        <ReferralCard collapsed={collapsed} referralCode={referralCode} />
        <WorkspaceMenu
          workspace={workspace} user={user} capabilities={capabilities}
          plan={plan} credits={credits} renewalDate={renewalDate} memberCount={memberCount}
          unread={unread} collapsed={collapsed} entitlements={entitlements}
        />
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden md:flex">{aside}</div>
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCloseMobile} />
          <div className="relative h-full">
            <button onClick={onCloseMobile} aria-label="Close menu" className="absolute right-2 top-3 z-10 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent bg-sidebar/80">
              <X className="h-4 w-4" />
            </button>
            {React.cloneElement(aside, { collapsed: false })}
          </div>
        </div>
      )}
    </>
  );
}