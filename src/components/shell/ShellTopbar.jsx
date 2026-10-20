import React from "react";
import { useLocation, Link } from "react-router-dom";
import { Menu, LogOut, CreditCard, Settings, ChevronRight } from "lucide-react";
import { base44 } from "@/api/base44Client";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import NotificationsDropdown from "@/components/shell/NotificationsDropdown";
import ThemeToggle from "@/components/shell/ThemeToggle";

const ROUTE_LABELS = {
  "/": "Home", "/projects": "Projects", "/mcp": "Integrations", "/analytics": "Usage",
  "/members": "Team", "/billing": "Billing", "/settings": "Settings",
  "/marketplace": "Marketplace", "/help": "Help",
  "/enterprise": "Organization", "/enterprise/sso": "SSO", "/enterprise/domains": "Domains",
  "/enterprise/scim": "SCIM", "/enterprise/groups": "Groups", "/enterprise/roles": "Roles",
  "/enterprise/security": "Security",
  "/compliance": "Compliance", "/compliance/legal": "Legal Documents", "/compliance/privacy": "Privacy Center",
  "/compliance/abuse": "Abuse Reporting", "/compliance/retention": "Retention", "/compliance/audit": "Audit Trail",
  "/compliance/breaches": "Data Breaches",
};

function Breadcrumbs({ workspace, pathname }) {
  const segs = pathname.split("/").filter(Boolean);
  const crumbs = [{ label: workspace?.name || "Workspace" }];
  if (segs.length) {
    const base = "/" + segs[0];
    crumbs.push({ label: ROUTE_LABELS[base] || segs[0], to: base });
  }
  if (segs.length > 1) {
    crumbs.push({ label: ROUTE_LABELS["/" + segs.slice(0, 2).join("/")] || segs[1] });
  }
  return (
    <nav className="flex items-center gap-1 text-[13px] min-w-0">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1 min-w-0">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />}
          {c.to ? (
            <Link to={c.to} className="text-muted-foreground hover:text-foreground truncate transition-colors">{c.label}</Link>
          ) : (
            <span className={`truncate ${i === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"}`}>{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export default function ShellTopbar({ workspace, user, loading, credits: pools, onOpenMobile, onOpenPalette }) {
  const { pathname } = useLocation();
  const initial = (user?.full_name || user?.email || "U").charAt(0).toUpperCase();
  const credits = pools?.message?.available;
  const integrationCredits = pools?.integration?.available;


  return (
    <header className="h-12 shrink-0 border-b border-border bg-background/80 backdrop-blur-md flex items-center gap-2.5 px-3">
      <button onClick={onOpenMobile} aria-label="Open menu" className="md:hidden text-muted-foreground hover:text-foreground p-1 rounded-md">
        <Menu className="h-5 w-5" />
      </button>

      <Breadcrumbs workspace={workspace} pathname={pathname} />

      <div className="flex-1" />

      <ThemeToggle />

      <NotificationsDropdown />

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-2 rounded-md p-0.5 hover:bg-muted transition-colors outline-none">
          <span className="h-7 w-7 rounded-full bg-gradient-to-br from-brand to-brand/80 text-brand-foreground grid place-items-center text-[12px] font-semibold">
            {loading ? "…" : initial}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="min-w-0">
            <div className="truncate font-medium text-[13px]">{user?.full_name || "User"}</div>
            <div className="truncate text-[11px] text-muted-foreground font-normal">{user?.email}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><Link to="/settings"><Settings className="h-4 w-4 mr-2" />Settings</Link></DropdownMenuItem>
          <DropdownMenuItem asChild><Link to="/billing"><CreditCard className="h-4 w-4 mr-2" />Billing</Link></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => base44.auth.logout()} className="text-destructive focus:text-destructive">
            <LogOut className="h-4 w-4 mr-2" />Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}