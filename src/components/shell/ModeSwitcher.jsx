import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { LayoutGrid, Bot, Code2, TrendingUp } from "lucide-react";

// Apps / Agent / Nexus Code / Grow switcher — the product's GLOBAL mode switch. Each mode is a
// real route: Apps is the app-building workspace at '/', Agent the autonomous-agent workspace at
// '/agent', Nexus Code the GitHub cloud-development surface at '/nexus-code', Grow the growth
// workspace at '/growth-agent'. Switching is client-side navigation, so authentication, workspace
// and cached state all survive it.
export const AGENT_ROUTE = "/agent";
const MODES = [
  { key: "apps", label: "Apps", icon: LayoutGrid, to: "/" },
  { key: "agent", label: "Agent", icon: Bot, to: AGENT_ROUTE },
  { key: "grow", label: "Grow", icon: TrendingUp, to: "/growth-agent" },
  { key: "nexus_code", label: "Nexus Code", icon: Code2, to: "/nexus-code" },
];

// Route-aware active-mode resolution. The audited boundaries, kept exact: the Agent mode claims
// its own route and everything nested under it, plus the Workflows page — the agent-mode surface
// whose sidebar entry lives in AGENT_PRIMARY. Nexus Code and Grow claim their own routes (and
// paths nested under them); every other route stays the Apps mode.
// Agent surfaces also include the agent-mode pages reached FROM Agent (Workflows, Plugins,
// Meetings, Notes): once the user is in Agent, opening any of them keeps the agent menu in
// place — the sidebar never flips back to the Apps menu from there.
export const isAgentMode = (pathname) =>
  pathname === AGENT_ROUTE ||
  pathname.startsWith(AGENT_ROUTE + "/") ||
  pathname === "/workflows" ||
  pathname === "/plugins" ||
  pathname === "/meetings" ||
  pathname === "/notes";
export const isNexusCodeMode = (pathname) => pathname === "/nexus-code" || pathname.startsWith("/nexus-code/");
export const isGrowMode = (pathname) => pathname === "/growth-agent" || pathname.startsWith("/growth-agent/");

const activeModeKey = (pathname) => {
  if (isAgentMode(pathname)) return "agent";
  if (isNexusCodeMode(pathname)) return "nexus_code";
  if (isGrowMode(pathname)) return "grow";
  return "apps";
};

export default function ModeSwitcher({ collapsed, onNavigate }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeKey = activeModeKey(pathname);

  const go = (mode) => { navigate(mode.to); onNavigate?.(); };

  // Vertical mode list — one row per mode, unique icon per mode; the active mode is tinted
  // blue and carries the flowing RGB border glow.
  const rowClass = (active) =>
    `relative w-full flex items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] font-medium transition-colors ${
      active ? "oled-border bg-brand-muted text-brand" : "text-sidebar-foreground/55 hover:bg-sidebar-accent/60"
    }`;

  if (collapsed) {
    return (
      <div className="flex flex-col gap-0.5">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = activeKey === m.key;
          return (
            <button key={m.key} type="button" title={m.label} onClick={() => go(m)} className={rowClass(active) + " justify-center"}>
              <Icon className="h-[15px] w-[15px]" />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-sidebar-accent/50 p-1">
      {MODES.map((m) => {
        const Icon = m.icon;
        const active = activeKey === m.key;
        return (
          <button key={m.key} type="button" onClick={() => go(m)} title={m.label} className={rowClass(active)}>
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate text-left">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}