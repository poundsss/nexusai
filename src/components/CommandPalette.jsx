import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Home, Boxes, BarChart3, CreditCard, Settings, Users, Plug, Plus, Rocket, TrendingUp,
  Search, CornerDownLeft, FileCode, Store, LifeBuoy, Coins,
  Building2, ShieldCheck, Globe, RefreshCw, KeyRound, Lock,
  Scale, FileText, Download, Flag, Database, History, AlertTriangle, Server, Star, Clock, User, Bot, UserPlus,
  Cable, StickyNote, LayoutDashboard,
} from "lucide-react";
import { useLocation } from "react-router-dom";
import { isAgentMode, isGrowMode } from "@/components/shell/ModeSwitcher";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import { canSeePath, hasCapability } from "@/lib/navAccess";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// AGENT-mode navigation: the palette follows the ACTIVE MODE, so Agent navigation is never listed
// as ordinary Apps navigation (and vice versa).
const AGENT_NAVIGATION = [
  { label: "Agent home", icon: Bot, to: "/agent", group: "Agent" },
  { label: "Notes", icon: StickyNote, to: "/notes", group: "Agent" },
];
const GROW_NAVIGATION = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/growth-agent?dashboard=1", group: "Grow" },
];
// Mirrors the sidebar's primary menu, then the workspace-popover entries. Same order, same
// labels, same gating — so the palette can never offer something the sidebar/popover hides.
const STATIC_COMMANDS = [
  { label: "Home", icon: Home, to: "/", group: "Navigation" },
  { label: "All apps", icon: Boxes, to: "/projects", group: "Navigation" },
  { label: "Templates", icon: Store, to: "/marketplace", group: "Navigation" },
  { label: "Community", icon: LifeBuoy, to: "/help", group: "Navigation" },
  { label: "Favorites", icon: Star, to: "/projects?filter=favorites", group: "Navigation" },
  { label: "Grow", icon: TrendingUp, to: "/growth-agent", group: "Navigation" },
  { label: "Recents", icon: Clock, to: "/projects?sort=recent", group: "Navigation" },
  { label: "Add members", icon: Users, to: "/members", group: "Workspace" },
  { label: "Settings", icon: Settings, to: "/settings", group: "Workspace" },
  { label: "Billing", icon: CreditCard, to: "/billing", group: "Workspace" },
  { label: "Profile", icon: User, to: "/settings", group: "Workspace" },
  { label: "Usage", icon: BarChart3, to: "/analytics", group: "Workspace" },
  { label: "Connectors", icon: Plug, to: "/mcp", group: "Workspace" },
  { label: "Connections", icon: Cable, to: "/connections", group: "Workspace" },
  { label: "API access", icon: KeyRound, to: "/api-access", group: "Workspace" },
  { label: "MCP server", icon: Server, to: "/app-mcp", group: "Workspace" },
  // Member-facing legal surfaces — NOT administration.
  { label: "Compliance", icon: Scale, to: "/compliance", group: "Legal & privacy" },
  { label: "Legal Documents", icon: FileText, to: "/compliance/legal", group: "Legal & privacy" },
  { label: "Privacy Center", icon: Download, to: "/compliance/privacy", group: "Legal & privacy" },
  { label: "Abuse Reporting", icon: Flag, to: "/compliance/abuse", group: "Legal & privacy" },
  { label: "Organization", icon: Building2, to: "/enterprise", group: "Administration" },
  { label: "SSO", icon: ShieldCheck, to: "/enterprise/sso", group: "Administration" },
  { label: "Domains", icon: Globe, to: "/enterprise/domains", group: "Administration" },
  { label: "SCIM", icon: RefreshCw, to: "/enterprise/scim", group: "Administration" },
  { label: "Roles", icon: KeyRound, to: "/enterprise/roles", group: "Administration" },
  { label: "Security", icon: Lock, to: "/enterprise/security", group: "Administration" },
  { label: "Retention", icon: Database, to: "/compliance/retention", group: "Administration" },
  { label: "Audit Trail", icon: History, to: "/compliance/audit", group: "Administration" },
  { label: "Data Breaches", icon: AlertTriangle, to: "/compliance/breaches", group: "Administration" },
  { label: "Platform admin", icon: Server, to: "/admin", group: "Administration" },
  { label: "New project", icon: Plus, to: "/projects?new=1", group: "Actions" },
  { label: "Buy credits", icon: Coins, to: "/billing", group: "Actions" },
  { label: "Deploy a project", icon: Rocket, to: "/projects", group: "Actions" },
];

export default function CommandPalette({ open, onOpenChange, plan, entitlements }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState([]);
  const [listings, setListings] = useState([]);
  const [projFiles, setProjFiles] = useState([]);
  const [projEntities, setProjEntities] = useState([]);
  const { workspace, user, capabilities } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const agentMode = isAgentMode(location.pathname);
  const growMode = isGrowMode(location.pathname);

  // The current builder project (from the route), so file/entity/publish commands are scoped to
  // the project the user is actually editing. Null outside the builder.
  const builderProjectId = useMemo(() => {
    const m = location.pathname.match(/^\/(?:projects|builder)\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);

  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);

  // Load projects AND marketplace listings when the palette opens so search includes both.
  useEffect(() => {
    if (!open || !workspace) return;
    Promise.all([
      workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50 }).then((d) => d.projects || []).catch(() => []),
      base44.functions.invoke("marketplace", { action: "browse", limit: 30 }).then((r) => r.data?.listings || []).catch(() => []),
    ]).then(([p, l]) => { setProjects(p); setListings(l); });
  }, [open, workspace]);

  // Load the current builder project's files + entities (same SDK calls as useProjectData) so the
  // palette can jump to a file or entity. Only when a builder project is open.
  useEffect(() => {
    if (!open || !builderProjectId) { setProjFiles([]); setProjEntities([]); return; }
    Promise.all([
      base44.functions.invoke("builderProjectRead", { project_id: builderProjectId }).then((r) => r.data?.files || []).catch(() => []),
      base44.entities.AppEntity.filter({ project_id: builderProjectId }, { sort: "name", limit: 200 }).then((p) => p.items || []).catch(() => []),
    ]).then(([f, e]) => { setProjFiles(f); setProjEntities(e); });
  }, [open, builderProjectId]);

  const projectCommands = useMemo(() => projects.map((p) => ({
    label: p.name,
    icon: FileCode,
    to: `/projects/${p.id}`,
    group: "Projects",
    hint: p.description,
  })), [projects]);

  const listingCommands = useMemo(() => listings.map((l) => ({
    label: l.name,
    icon: Store,
    to: `/marketplace/${l.slug}`,
    group: "Marketplace",
    hint: l.summary || l.kind,
  })), [listings]);

  // File jumps: open a project file in the builder's Build view (?file=, the existing deep-link
  // mechanism the builder honors). Offered only for the project currently open in the builder.
  const fileCommands = useMemo(() => builderProjectId ? projFiles.map((f) => ({
    label: f.path.replace(/^.*\//, ""),
    icon: FileCode,
    to: `/projects/${builderProjectId}?file=${encodeURIComponent(f.path)}`,
    group: "Files",
    hint: f.path,
  })) : [], [builderProjectId, projFiles]);

  // Entity jumps: open the builder's Data pane on an entity (?entity=). Reuses the same AppEntity
  // source as the builder file tree.
  const entityCommands = useMemo(() => builderProjectId ? projEntities.map((e) => ({
    label: e.name,
    icon: Database,
    to: `/projects/${builderProjectId}?entity=${encodeURIComponent(e.name)}`,
    group: "Entities",
    hint: `${Object.keys(e.fields || {}).length} fields`,
  })) : [], [builderProjectId, projEntities]);

  // Quick actions. Publish reuses the builder's Publish modal (?publish=1) and is gated by the
  // deploy.manage capability (owner/admin). Invite reuses the Members invite form and is gated by
  // member.manage (owner/admin). Both still land on routes the server re-authorizes.
  const actionCommands = useMemo(() => {
    const out = [];
    if (builderProjectId && hasCapability(capabilities, "deploy.manage")) {
      out.push({ label: "Publish", icon: Rocket, to: `/projects/${builderProjectId}?publish=1`, group: "Actions" });
    }
    if (hasCapability(capabilities, "member.manage")) {
      out.push({ label: "Invite collaborators", icon: UserPlus, to: "/members", group: "Actions" });
    }
    return out;
  }, [builderProjectId, capabilities]);

  // Gated by the SAME predicate the sidebar uses, from the one shared module, so the palette can
  // never offer a route the sidebar hides. Public commands pass through; the server still authorizes.
  // In Agent mode the Apps navigation group is replaced by the Agent group; every other group
  // (Workspace, Legal, Administration, Actions) is mode-independent and keeps its own gating.
  const visibleStatic = useMemo(() => {
    const modeNavigation = agentMode ? AGENT_NAVIGATION : growMode ? GROW_NAVIGATION : null;
    const base = modeNavigation
      ? [...modeNavigation, ...STATIC_COMMANDS.filter((c) => c.group !== "Navigation")]
      : STATIC_COMMANDS;
    return base.filter((c) => canSeePath(c.to, { user, capabilities, plan, entitlements }));
  }, [agentMode, growMode, user, capabilities, plan, entitlements]);

  const allCommands = useMemo(() => [...projectCommands, ...listingCommands, ...fileCommands, ...entityCommands, ...actionCommands, ...visibleStatic], [projectCommands, listingCommands, fileCommands, entityCommands, actionCommands, visibleStatic]);

  const filtered = allCommands.filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase()) ||
    (c.hint && c.hint.toLowerCase().includes(query.toLowerCase()))
  );
  const groups = [...new Set(filtered.map((c) => c.group))];

  const run = (cmd) => { onOpenChange(false); navigate(cmd.to); };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) run(filtered[active]); }
  };

  let idx = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 max-w-xl overflow-hidden" onKeyDown={onKeyDown}>
        <DialogHeader className="sr-only"><DialogTitle>Command palette</DialogTitle></DialogHeader>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            placeholder="Search projects, marketplace, or jump to…"
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
          <kbd className="text-[10px] font-mono rounded bg-muted border border-border px-1.5 py-0.5 text-muted-foreground">esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-muted-foreground">No results for "{query}"</div>
          ) : (
            groups.map((group) => (
              <div key={group} className="mb-1">
                <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">{group}</div>
                {filtered.filter((c) => c.group === group).map((cmd) => {
                  idx++;
                  const isActive = idx === active;
                  const Icon = cmd.icon;
                  return (
                    <button
                      key={cmd.label + cmd.to}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => run(cmd)}
                      className={`w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-left transition-colors ${
                        isActive ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.hint && <span className="text-[11px] text-muted-foreground/60 truncate max-w-[200px]">{cmd.hint}</span>}
                      {isActive && <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}