import React, { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { useShellData } from "@/hooks/useShellData";
import ShellSidebar from "@/components/shell/ShellSidebar";
import ShellTopbar from "@/components/shell/ShellTopbar";
import CommandPalette from "@/components/CommandPalette";

// Unified application shell: one sidebar + topbar + command palette wrapping every
// authenticated NexusAI page. Pages render only their content via <Outlet /> — the shell
// owns navigation, workspace context, search, and the account popover so the product feels
// like one application, not a collection of screens that each built their own chrome.
export default function AppShell() {
  const { user, workspace, role, capabilities, loading, plan, credits, renewalDate, memberCount, recents, referralCode, entitlements } = useShellData();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The global workspace topbar is not rendered on the authenticated Home screen ('/') or inside an
  // OPENED APPLICATION (/projects/:id): those surfaces occupy the working area directly, starting at
  // the very top with no reserved vertical space. Every other shell screen keeps it.
  const { pathname } = useLocation();
  const hideTopbar =
    pathname === "/" ||
    pathname === "/agent" ||
    pathname.startsWith("/agent/") ||
    pathname === "/workflows" ||
    pathname === "/plugins" ||
    pathname === "/meetings" ||
    pathname === "/notes" ||
    pathname === "/agent/settings" ||
    pathname.startsWith("/growth-agent") ||
    pathname.startsWith("/nexus-code") ||
    /^\/projects\/[^/]+/.test(pathname);
  // Inside an opened app (Builder) the whole left application bar is hidden too — the user has
  // already navigated INTO the builder, so the workspace nav menu is not shown there.
  const hideSidebar =
    /^\/projects\/[^/]+/.test(pathname) || /^\/builder\/[^/]+/.test(pathname);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      {!hideSidebar && (
        <ShellSidebar
          workspace={workspace} user={user} role={role} capabilities={capabilities} loading={loading} referralCode={referralCode}
          plan={plan} credits={credits} renewalDate={renewalDate} memberCount={memberCount} recents={recents}
          collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)}
          mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)}
          onOpenPalette={() => setPaletteOpen(true)}
        />
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        {!hideTopbar && (
          <ShellTopbar
            workspace={workspace} user={user} loading={loading} credits={credits}
            collapsed={collapsed}
            onOpenMobile={() => setMobileOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
          />
        )}
        {/* On the surfaces that intentionally have no topbar, mobile still needs a way into
            navigation — the sidebar itself is desktop-only. */}
        {hideTopbar && !hideSidebar && (
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="md:hidden fixed left-3 top-3 z-40 grid place-items-center h-9 w-9 rounded-lg border border-border bg-background/90 backdrop-blur text-muted-foreground shadow-sm hover:text-foreground"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} plan={plan} entitlements={entitlements} />
    </div>
  );
}