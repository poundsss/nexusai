import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  Search, LayoutDashboard, Users, Database, BarChart3, Globe, Blocks, ShieldCheck, Code2,
  Bot, Workflow, ScrollText, Settings as SettingsIcon, Cable, KeyRound,
} from "lucide-react";

// Navigation rail of the in-Builder project dashboard. Every entry lands on a real surface:
// the Builder's own management views, the workspace pages the Builder does not own, or the
// activity monitor.
const NAV = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, self: true },
  { id: "users", label: "App Users", icon: Users, view: "app_users" },
  { id: "data", label: "Data", icon: Database, view: "data" },
  { id: "analytics", label: "Analytics", icon: BarChart3, to: "/app-analytics" },
  { id: "domains", label: "Domains", icon: Globe, view: "settings" },
  { id: "integrations", label: "Integrations", icon: Blocks, view: "integrations" },
  { id: "security", label: "Security", icon: ShieldCheck, view: "settings" },
  { id: "code", label: "Code", icon: Code2, view: "code" },
  { id: "agents", label: "Agents", icon: Bot, view: "agents" },
  { id: "workflows", label: "Workflows", icon: Workflow, view: "logic", badge: "New" },
  { id: "logs", label: "Logs", icon: ScrollText, activity: true },
  { id: "settings", label: "Settings", icon: SettingsIcon, view: "settings" },
  { id: "mcp", label: "MCP", icon: Cable, to: "/mcp" },
  { id: "secrets", label: "Secrets", icon: KeyRound, view: "secrets" },
];

export default function DashboardSidebar({ onCenterView, onOpenActivity }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items = NAV.filter((n) => n.label.toLowerCase().includes(q));

  const cls = (self) =>
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors " +
    (self ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/60");

  return (
    <nav className="w-[218px] shrink-0 border-r border-border flex flex-col">
      <div className="p-3 border-b border-border">
        <div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 h-8">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search..."
            aria-label="Search dashboard"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin p-2 space-y-0.5">
        {items.map((n) => {
          const Icon = n.icon;
          const badge = n.badge ? (
            <span className="ml-auto rounded-full bg-foreground px-1.5 py-0.5 text-[9.5px] font-semibold leading-none text-background">{n.badge}</span>
          ) : null;
          const inner = (
            <>
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {n.label}
              {badge}
            </>
          );
          if (n.self) return <span key={n.id} className={cls(true)}>{inner}</span>;
          if (n.to) return <Link key={n.id} to={n.to} className={cls(false)}>{inner}</Link>;
          return (
            <button key={n.id} onClick={() => (n.activity ? onOpenActivity() : onCenterView(n.view))} className={cls(false)}>
              {inner}
            </button>
          );
        })}
      </div>
    </nav>
  );
}