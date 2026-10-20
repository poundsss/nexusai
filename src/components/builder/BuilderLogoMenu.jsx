import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Settings, DollarSign, Gift, FileText, Handshake, HelpCircle, Plus, LogOut, ChevronsUpDown,
} from "lucide-react";
import moment from "moment";
import { useShellData } from "@/hooks/useShellData";
import { fmtCredits } from "@/lib/planCredits";
import { base44 } from "@/api/base44Client";

// Builder profile menu — triggered by the user avatar in the logo bar. Mirrors the reference:
// user name + plan (subscription status), per-pool credits (token usage, like the home page),
// then the account menu (Settings, Create new team, Pricing, …). All entries route to EXISTING
// internal pages; no new surfaces are created.
const ITEMS = [
  { label: "Pricing plans", icon: DollarSign, to: "/billing" },
  { label: "Earn free credits", icon: Gift, to: "/billing" },
  { label: "Documentation", icon: FileText, href: "https://docs.base44.com" },
  { label: "Hire a partner", icon: Handshake, to: "/marketplace" },
  { label: "Get help", icon: HelpCircle, to: "/help" },
];

export default function BuilderLogoMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const { user, credits, renewalDate, plan } = useShellData();

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const pools = [
    { label: "Message", p: credits?.message },
    { label: "Integration", p: credits?.integration },
  ];
  const initial = (user?.full_name || user?.email || "U").charAt(0).toUpperCase();
  const planLabel = plan?.name || plan?.code || "Free";
  const renews = renewalDate ? `Renews at ${moment.utc(renewalDate).format("MMM D, YYYY | h:mm A [UTC]")}` : null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Profile menu"
        aria-expanded={open}
        className="flex items-center gap-0.5 rounded-full pl-0.5 pr-1 hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="h-6 w-6 rounded-full bg-gradient-to-br from-[#60a5fa] to-[#1d4ed8] text-white grid place-items-center text-[11px] font-semibold">{initial}</span>
        <ChevronsUpDown className="h-3 w-3 text-muted-foreground/70" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-72 rounded-xl border border-border bg-popover shadow-lg overflow-hidden">
          {/* Header — user name + plan (subscription status) */}
          <div className="px-3 pt-3 pb-2">
            <div className="flex items-center gap-2.5">
              <span className="h-9 w-9 rounded-lg bg-gradient-to-br from-[#60a5fa] to-[#1d4ed8] text-white grid place-items-center text-[13px] font-semibold">{initial}</span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{user?.full_name || user?.email || "Account"}</div>
                <div className="text-[11px] text-muted-foreground">{planLabel} plan</div>
              </div>
            </div>
          </div>
          <div className="h-px bg-border" />

          {/* Credits — per-pool token usage (Message / Integration), like the home page */}
          <div className="px-3 py-3">
            <div className="text-[12.5px] font-semibold">Credits</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{renews || "—"}</p>
            <div className="mt-2 space-y-2">
              {pools.map(({ label, p }) => {
                const avail = typeof p?.available === "number" ? p.available : null;
                const incl = typeof p?.included === "number" ? p.included : null;
                const known = incl !== null && incl > 0;
                const pct = known && avail !== null ? Math.max(0, Math.min(100, (avail / incl) * 100)) : null;
                return (
                  <div key={label}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">{label}</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {fmtCredits(avail)}{known ? <span className="text-muted-foreground/70"> / {fmtCredits(incl)}</span> : null}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-blue-500" style={{ width: pct == null ? "100%" : `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <Link
              to="/billing"
              onClick={() => setOpen(false)}
              className="mt-2.5 flex items-center justify-center h-8 w-full rounded-md border border-blue-500 text-blue-500 text-[12px] font-medium hover:bg-blue-500/10 transition-colors"
            >
              Upgrade your plan
            </Link>
          </div>
          <div className="h-px bg-border" />

          {/* Menu list — profile settings + create new team + the rest + log out */}
          <div className="p-1">
            <Link to="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-foreground hover:bg-accent transition-colors w-full">
              <Settings className="h-3.5 w-3.5 text-muted-foreground shrink-0" />Settings
            </Link>
            <button onClick={() => { setOpen(false); navigate("/enterprise"); }} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-foreground hover:bg-accent transition-colors w-full">
              <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />Create new team
            </button>
            {ITEMS.map((it) => {
              const Icon = it.icon;
              const inner = (
                <span className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-foreground hover:bg-accent transition-colors w-full">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>{it.label}</span>
                </span>
              );
              return it.href ? (
                <a key={it.label} href={it.href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                  {inner}
                </a>
              ) : (
                <Link key={it.label} to={it.to} onClick={() => setOpen(false)}>
                  {inner}
                </Link>
              );
            })}
            <div className="h-px bg-border my-1" />
            <button onClick={() => base44.auth.logout()} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-destructive hover:bg-accent transition-colors w-full">
              <LogOut className="h-3.5 w-3.5 shrink-0" />Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}