import React from "react";
import { Link } from "react-router-dom";
import {
  LogOut, Settings, UserPlus, Info, ChevronsUpDown, ArrowUpRight, User, Handshake, Languages, LifeBuoy,
  Building2, Lock, Database, History, AlertTriangle, Server, Plug, Cable, KeyRound, Store,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { canSeePath } from "@/lib/navAccess";
import CreditMeter from "@/components/shell/CreditMeter";

// Administration lives ONLY here, gated by the one shared navAccess rule set. No new capability is
// introduced and the server re-authorizes every route regardless of what this popover renders.
const ADMIN_ENTRIES = [
  { label: "Organization", icon: Building2, to: "/enterprise" },
  { label: "Security", icon: Lock, to: "/enterprise/security" },
  { label: "Retention", icon: Database, to: "/compliance/retention" },
  { label: "Audit trail", icon: History, to: "/compliance/audit" },
  { label: "Breaches", icon: AlertTriangle, to: "/compliance/breaches" },
  { label: "Platform admin", icon: Server, to: "/admin" },
];

// Build tools relocated from the main sidebar (audit parity): Base44 keeps these under workspace /
// account settings, not as top-level navigation. Gated by the same shared navAccess rules; the
// server re-authorizes every route regardless of what this popover renders.
const BUILD_TOOLS = [
  { label: "Connectors", icon: Plug, to: "/mcp" },
  { label: "Connections", icon: Cable, to: "/connections" },
  { label: "API access", icon: KeyRound, to: "/api-access" },
  { label: "MCP server", icon: Server, to: "/app-mcp" },
];

const GroupLabel = ({ children }) => (
  <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">{children}</div>
);

export default function WorkspaceMenu({ workspace, user, capabilities, plan, credits, renewalDate, memberCount, unread, collapsed, entitlements = {} }) {
  const initial = (user?.full_name || user?.email || "U").charAt(0).toUpperCase();
  const wsInitial = (workspace?.name || "W").charAt(0).toUpperCase();
  const adminItems = ADMIN_ENTRIES.filter((i) => canSeePath(i.to, { user, capabilities, plan, entitlements }));
  const buildItems = BUILD_TOOLS.filter((i) => canSeePath(i.to, { user, capabilities, plan, entitlements }));
  const planLabel = plan?.name || plan?.code || "Free";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sidebar-accent transition-colors outline-none ${collapsed ? "justify-center" : ""}`}>
        <span className="relative shrink-0">
          <span className="h-6 w-6 rounded-full bg-gradient-to-br from-brand to-brand/80 text-brand-foreground grid place-items-center text-[11px] font-semibold">{initial}</span>
          {unread > 0 && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar" />}
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 min-w-0 text-left">
              <span className="block text-[12px] font-medium truncate text-sidebar-foreground">{workspace?.name || "Workspace"}</span>
              <span className="block text-[11px] truncate text-sidebar-foreground/50">{user?.email || "Account"}</span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-[300px] p-0 max-h-[80vh] overflow-y-auto">
        {/* Workspace header */}
        <div className="flex items-center gap-2.5 p-3">
          <span className="h-9 w-9 shrink-0 rounded-lg bg-foreground text-background grid place-items-center text-[13px] font-semibold">{wsInitial}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{workspace?.name || "Workspace"}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {memberCount === null ? "—" : `${memberCount} member${memberCount === 1 ? "" : "s"}`} · <span className="capitalize">{planLabel}</span>
            </div>
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" title="Switch workspace" />
        </div>

        <DropdownMenuSeparator className="m-0" />

        {/* Credits */}
        <div className="p-3 space-y-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold">Credits</span>
            <Info className="h-3 w-3 text-muted-foreground/60" title="Credits are consumed by AI runs and integration calls." />
            <span className="ml-auto text-[11px] text-muted-foreground">
              {renewalDate ? `Renews ${new Date(renewalDate).toLocaleDateString()}` : "No renewal date"}
            </span>
          </div>
          <CreditMeter label="Message credits available" used={credits?.message?.available} limit={credits?.message?.included} />
          <CreditMeter label="Integration credits available" used={credits?.integration?.available} limit={credits?.integration?.included} />
          <Link to="/billing" className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-brand-foreground px-3 py-1.5 text-[12px] font-medium hover:bg-brand/90 transition-colors">
            <ArrowUpRight className="h-3.5 w-3.5" />Upgrade your plan
          </Link>
        </div>

        <DropdownMenuSeparator className="m-0" />

        {/* Workspace */}
        <GroupLabel>Workspace</GroupLabel>
        <DropdownMenuItem asChild><Link to="/members"><UserPlus className="h-4 w-4 mr-2" />Add members</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link to="/settings"><Settings className="h-4 w-4 mr-2" />Settings</Link></DropdownMenuItem>

        {buildItems.length > 0 && (
          <>
            <DropdownMenuSeparator className="m-0" />
            <GroupLabel>Build tools</GroupLabel>
            {buildItems.map((item) => {
              const Icon = item.icon;
              return (
                <DropdownMenuItem key={item.to} asChild>
                  <Link to={item.to}><Icon className="h-4 w-4 mr-2" />{item.label}</Link>
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {adminItems.length > 0 && (
          <>
            <DropdownMenuSeparator className="m-0" />
            <GroupLabel>Administration</GroupLabel>
            {adminItems.map((item) => {
              const Icon = item.icon;
              return (
                <DropdownMenuItem key={item.to} asChild>
                  <Link to={item.to}><Icon className="h-4 w-4 mr-2" />{item.label}</Link>
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        <DropdownMenuSeparator className="m-0" />

        {/* Account */}
        <GroupLabel>Account</GroupLabel>
        <div className="px-2 pb-1 text-[11px] text-muted-foreground truncate">{user?.email || "—"}</div>
        <DropdownMenuItem asChild><Link to="/settings"><User className="h-4 w-4 mr-2" />View profile</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link to="/billing"><Handshake className="h-4 w-4 mr-2" />Become an affiliate</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link to="/settings"><Languages className="h-4 w-4 mr-2" />Language<span className="ml-auto text-[11px] text-muted-foreground">English</span></Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link to="/help"><LifeBuoy className="h-4 w-4 mr-2" />Help & support</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link to="/marketplace?tab=partners"><Store className="h-4 w-4 mr-2" />Partners</Link></DropdownMenuItem>
        <DropdownMenuSeparator className="m-0" />
        <DropdownMenuItem onClick={() => base44.auth.logout()} className="text-destructive focus:text-destructive">
          <LogOut className="h-4 w-4 mr-2" />Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}