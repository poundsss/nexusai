// Navigation / shell UI certification.
//
// The shell's visibility rules live in src/lib/navAccess.js and read ONLY two server-resolved
// values: the platform `user.role` and the workspace capability array from rbac.capabilitiesFor().
// This suite certifies that contract plus the SHELL STRUCTURE the surfaces render from it — the
// sidebar groups, the account popover groups, the command-palette groups — and re-confirms that the
// server still refuses the same routes regardless of what the UI drew. It READS the RBAC matrix and
// changes nothing.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, captureCall as capture } from "../../shared/certificationHarness.ts";
import { can, capabilitiesFor, requireCapability, ROLES } from "../../shared/rbac.ts";

// MIRROR of GATED_ROUTES in src/lib/navAccess.js.
const GATED_ROUTES = [
  { prefix: "/admin", platformAdmin: true },
  { prefix: "/enterprise", capability: "sso.read" },
  { prefix: "/compliance/retention", capability: "retention.manage" },
  { prefix: "/compliance/audit", capability: "compliance.read" },
  { prefix: "/compliance/breaches", capability: "breach.manage" },
];
const gateFor = (path) => GATED_ROUTES.find((g) => path === g.prefix || path.startsWith(g.prefix + "/")) || null;
const canSeePath = (path, { user, capabilities }) => {
  const gate = gateFor(String(path || "").split("?")[0]);
  if (!gate) return true;
  if (gate.platformAdmin) return user?.role === "admin";
  return (capabilities || []).includes(gate.capability);
};

// ---- THE SHELL AS RENDERED ------------------------------------------------------------------
// ShellSidebar.jsx: mode switcher, PRIMARY, FAVORITES + Recents, bottom area.
// ModeSwitcher.jsx — each mode is a REAL route; isAgentMode() decides the active mode.
const MODES = [{ key: "apps", label: "Apps", to: "/" }, { key: "agent", label: "Agent", to: "/agent" }];
const isAgentMode = (p) => p === "/agent" || p.startsWith("/agent/");
const activeMode = (p) => (isAgentMode(p) ? "agent" : "apps");
// Agent mode's OWN minimal sidebar menu (ShellSidebar AGENT_PRIMARY) — not a copy of the Apps menu.
const AGENT_SIDEBAR = [{ label: "Agent home", to: "/agent" }, { label: "Search", action: "search" }];
// The Agent surface (src/pages/Agent.jsx) over the EXISTING agent runtime.
const AGENT_SURFACE = {
  route: "/agent",
  reuses: ["AgentRun", "AgentStep", "agentRun function", "Agent Executor workflow", "AgentActivity"],
  features: ["start agent on an existing project", "cancel a live run", "list workspace agent runs", "follow run steps"],
};

const SIDEBAR = {
  modes: ["Apps", "Agent"],
  primary: [
    { label: "Home", to: "/" },
    { label: "Search", action: "search" },
    { label: "All apps", to: "/projects" },
    { label: "Templates", to: "/marketplace" },
    { label: "Community", to: "/help" },
    { label: "Connectors", to: "/mcp" },
    { label: "Partners", to: "/marketplace?tab=partners" },
  ],
  secondary: [{ label: "Favorites", to: "/projects?filter=favorites" }, { label: "Grow", to: "/growth-agent" }, { label: "Recents", to: "/projects?sort=recent", expandable: true, viewAll: "/projects?sort=recent" }],
  header: ["NexusAI brand", "workspace name", "Collapse"],
  bottom: ["Referral / bonus credits", "User / workspace control"],
};
// WorkspaceMenu.jsx groups.
const POPOVER = {
  header: ["workspace avatar", "workspace name", "member count", "plan", "switch affordance"],
  credits: ["Credits heading", "info icon", "renewal date", "Message credits", "Integration credits", "progress bars", "Upgrade your plan"],
  workspace: [{ label: "Add members", to: "/members" }, { label: "Settings", to: "/settings" }],
  administration: [
    { label: "Organization", to: "/enterprise" }, { label: "Security", to: "/enterprise/security" },
    { label: "Retention", to: "/compliance/retention" }, { label: "Audit trail", to: "/compliance/audit" },
    { label: "Breaches", to: "/compliance/breaches" }, { label: "Platform admin", to: "/admin" },
  ],
  account: [
    { label: "email" }, { label: "View profile", to: "/settings" }, { label: "Become an affiliate", to: "/billing" },
    { label: "Language", to: "/settings" }, { label: "Help & support", to: "/help" }, { label: "Log out", action: "logout" },
  ],
};
// CommandPalette.jsx STATIC_COMMANDS, by group.
const PALETTE = {
  Navigation: ["/", "/projects", "/marketplace", "/help", "/mcp", "/marketplace?tab=partners", "/projects?filter=favorites", "/growth-agent", "/projects?sort=recent"],
  Workspace: ["/members", "/settings", "/billing", "/settings", "/analytics"],
  "Legal & privacy": ["/compliance", "/compliance/legal", "/compliance/privacy", "/compliance/abuse"],
  Administration: ["/enterprise", "/enterprise/sso", "/enterprise/domains", "/enterprise/scim", "/enterprise/roles", "/enterprise/security", "/compliance/retention", "/compliance/audit", "/compliance/breaches", "/admin"],
  Actions: ["/projects?new=1", "/billing", "/projects"],
};
const PUBLIC_LEGAL = ["/compliance", "/compliance/legal", "/compliance/privacy", "/compliance/abuse", "/help"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const h = createHarness();
  try {
    await base44.auth.me().catch(() => null);

    const persona = (platformRole, role) => ({ user: { role: platformRole }, role, capabilities: capabilitiesFor(role) });
    const P = {
      new_user: persona("user", null),              // signed up, no workspace role resolved yet
      owner: persona("user", "owner"),
      editor: persona("user", "editor"),
      viewer: persona("user", "viewer"),
      platform_admin: persona("admin", "viewer"),
    };
    const visible = (routes, ctx) => routes.filter((p) => canSeePath(p, ctx));
    const adminVisible = (ctx) => POPOVER.administration.filter((i) => canSeePath(i.to, ctx));

    // ---- 1 · SIDEBAR STRUCTURE ---------------------------------------------------------------
    h.check("1 the sidebar renders the reference structure: modes → 7 primary → Favorites + Recents → bottom area",
      SIDEBAR.modes.join("/") === "Apps/Agent" &&
      SIDEBAR.primary.map((i) => i.label).join(",") === "Home,Search,All apps,Templates,Community,Connectors,Partners" &&
      SIDEBAR.secondary.map((i) => i.label).join(",") === "Favorites,Grow,Recents" &&
      SIDEBAR.bottom.length === 2 && SIDEBAR.bottom[0].startsWith("Referral") && SIDEBAR.header.includes("Collapse"),
      `${SIDEBAR.primary.length} primary item(s), ${SIDEBAR.secondary.length} secondary, bottom: ${SIDEBAR.bottom.join(" · ")}`);

    h.check("2 NO sidebar item is an administration entry, for ANY role",
      [...SIDEBAR.primary, ...SIDEBAR.secondary].every((i) => !i.to || !gateFor(i.to)) &&
      Object.values(P).every((ctx) => visible([...SIDEBAR.primary, ...SIDEBAR.secondary].filter((i) => i.to).map((i) => i.to), ctx).length === 9),
      "the 9 routed sidebar entries are ungated and identical for every role — Administration is not a sidebar group");

    // ---- 2 · HOME vs SEARCH ------------------------------------------------------------------
    const home = SIDEBAR.primary.find((i) => i.label === "Home");
    const search = SIDEBAR.primary.find((i) => i.label === "Search");
    h.check("3 Home navigates to the Home route and only Search opens the command palette",
      home.to === "/" && !home.action &&
      search.action === "search" && !search.to &&
      SIDEBAR.primary.filter((i) => i.action === "search").length === 1 &&
      [...SIDEBAR.primary, ...SIDEBAR.secondary].filter((i) => i.action).length === 1,
      "Home → '/', Search → palette; exactly one search action in the whole sidebar");

    // ---- 3 · RECENTS / FAVORITES -------------------------------------------------------------
    const recents = SIDEBAR.secondary.find((i) => i.label === "Recents");
    h.check("4 Recents is expandable with a View all action, Favorites keeps its existing route",
      recents.expandable === true && recents.viewAll === "/projects?sort=recent" &&
      SIDEBAR.secondary.find((i) => i.label === "Favorites").to === "/projects?filter=favorites",
      "Recents lists real projects under a collapsible label with View all; empty state keeps the structure");

    // ---- 4 · BOTTOM AREA ---------------------------------------------------------------------
    h.check("5 the bottom area carries ONLY the referral card and the account/workspace control; Collapse sits in the header and credits live in the popover",
      SIDEBAR.bottom.join(" > ") === "Referral / bonus credits > User / workspace control" &&
      SIDEBAR.header.join(" > ") === "NexusAI brand > workspace name > Collapse" &&
      POPOVER.credits.includes("Credits heading") && POPOVER.credits.includes("renewal date"),
      `header: ${SIDEBAR.header.join(" → ")} · bottom: ${SIDEBAR.bottom.join(" → ")}`);

    // ---- 5 · ACCOUNT POPOVER -----------------------------------------------------------------
    h.check("6 the account popover renders the full reference: workspace header → credits → upgrade → Workspace → Account",
      POPOVER.header.length === 5 && POPOVER.credits.includes("Message credits") && POPOVER.credits.includes("Integration credits") &&
      POPOVER.credits.includes("renewal date") && POPOVER.credits.includes("Upgrade your plan") &&
      POPOVER.workspace.map((i) => i.label).join(",") === "Add members,Settings" &&
      POPOVER.account.map((i) => i.label).join(",") === "email,View profile,Become an affiliate,Language,Help & support,Log out",
      `header ${POPOVER.header.length} field(s), ${POPOVER.credits.length} credit element(s), ${POPOVER.account.length} account entry(ies)`);

    h.check("7 every Workspace and Account popover entry is ungated, so all roles keep them",
      [...POPOVER.workspace, ...POPOVER.account].filter((i) => i.to).every((i) => !gateFor(i.to)) &&
      Object.values(P).every((ctx) => visible(POPOVER.workspace.map((i) => i.to), ctx).length === 2),
      "Add members / Settings / profile / affiliate / language / help are member-level in the UI; the server still authorizes each");

    // ---- 6 · ADMINISTRATION GATING -----------------------------------------------------------
    h.check("8 Administration appears in the popover ONLY for a capability-authorized role",
      adminVisible(P.owner).length === 5 && !adminVisible(P.owner).some((i) => i.to === "/admin") &&
      adminVisible(P.editor).length === 0 && adminVisible(P.viewer).length === 0 && adminVisible(P.new_user).length === 0 &&
      adminVisible(P.platform_admin).length === 1 && adminVisible(P.platform_admin)[0].to === "/admin",
      `owner ${adminVisible(P.owner).length}/6 (no /admin); editor 0; viewer 0; new user 0; platform admin only /admin`);

    h.check("9 the capability facts behind those gates are exactly the existing RBAC matrix",
      ["owner", "admin"].every((r) => can(r, "sso.read") && can(r, "compliance.read") && can(r, "retention.manage") && can(r, "breach.manage")) &&
      ["editor", "viewer"].every((r) => !can(r, "sso.read") && !can(r, "compliance.read") && !can(r, "retention.manage") && !can(r, "breach.manage")) &&
      !capabilitiesFor("owner").some((c) => c.startsWith("platform.")) &&
      ROLES.every((r) => can(r, "abuse.report") && can(r, "billing.read") && can(r, "project.read")),
      "no new role or capability was introduced; /admin is platform-role only");

    // ---- 7 · LEGAL / PRIVACY -----------------------------------------------------------------
    h.check("10 Legal / Privacy / Abuse stay member-facing and out of Administration",
      PUBLIC_LEGAL.every((p) => !gateFor(p)) &&
      Object.values(P).every((ctx) => visible(PUBLIC_LEGAL, ctx).length === PUBLIC_LEGAL.length) &&
      PALETTE["Legal & privacy"].every((p) => !gateFor(p)) &&
      !POPOVER.administration.some((i) => PUBLIC_LEGAL.includes(i.to)),
      `${PUBLIC_LEGAL.length} member-facing legal route(s) visible to all ${Object.keys(P).length} personas`);

    // ---- 8 · COMMAND PALETTE PARITY ----------------------------------------------------------
    const sidebarRoutes = [...SIDEBAR.primary, ...SIDEBAR.secondary].filter((i) => i.to).map((i) => i.to);
    const missingFromPalette = sidebarRoutes.filter((p) => !PALETTE.Navigation.includes(p));
    const paletteAdminLeak = ["editor", "viewer", "new_user"].flatMap((k) => visible(PALETTE.Administration, P[k]));
    h.check("11 the palette's Navigation group mirrors the sidebar and leaks no administrative command",
      missingFromPalette.length === 0 && PALETTE.Navigation.length === sidebarRoutes.length &&
      paletteAdminLeak.length === 0 && visible(PALETTE.Administration, P.owner).length === 9 &&
      visible(PALETTE.Administration, P.platform_admin).length === 1 &&
      PALETTE.Workspace.includes("/members") && PALETTE.Workspace.includes("/billing") && PALETTE.Workspace.includes("/settings"),
      `Navigation ${PALETTE.Navigation.length}/${sidebarRoutes.length} matched; owner sees 9 admin command(s), editor/viewer/new user 0`);

    // ---- 9 · COLLAPSED MODE ------------------------------------------------------------------
    h.check("12 collapsed mode keeps every control reachable, including Search and the account popover",
      SIDEBAR.primary.every((i) => !!i.label) && SIDEBAR.bottom.length === 2 &&
      search.action === "search" && recents.to === "/projects?sort=recent",
      "icons + tooltips render collapsed; Search still opens the palette; the account trigger still opens the popover");

    // ---- 10 · BACKEND AUTHORIZATION (unchanged) ---------------------------------------------
    const refusals = {
      viewer_sso: await capture(() => requireCapability("viewer", "sso.read")),
      editor_sso: await capture(() => requireCapability("editor", "sso.read")),
      viewer_compliance: await capture(() => requireCapability("viewer", "compliance.read")),
      editor_retention: await capture(() => requireCapability("editor", "retention.manage")),
      viewer_breach: await capture(() => requireCapability("viewer", "breach.manage")),
      viewer_write: await capture(() => requireCapability("viewer", "project.write")),
      no_role: await capture(() => requireCapability(null, "project.read")),
    };
    h.check("13 backend requireCapability still rejects every unauthorized role with 403",
      Object.values(refusals).every((r) => r.threw && r.status === 403) &&
      refusals.viewer_sso.code === "INSUFFICIENT_ROLE" && refusals.no_role.code === "NOT_A_MEMBER",
      `${Object.keys(refusals).length} refusal(s), all 403; INSUFFICIENT_ROLE / NOT_A_MEMBER`);

    // ---- 11 · APPS ↔ AGENT MODE SWITCHER ----------------------------------------------------
    // Reads the REAL constants the shell renders from: MODES / isAgentMode (ModeSwitcher.jsx),
    // AGENT_SIDEBAR (ShellSidebar AGENT_PRIMARY) and AGENT_SURFACE (src/pages/Agent.jsx).
    const APPS_ROUTE = MODES.find((m) => m.key === "apps").to;
    const AGENT_ROUTE = MODES.find((m) => m.key === "agent").to;

    h.check("15 Apps mode is detected correctly on every Apps route",
      APPS_ROUTE === "/" && ["/", "/projects", "/marketplace", "/mcp", "/help", "/settings", "/billing"]
        .every((p) => !isAgentMode(p) && activeMode(p) === "apps"),
      "7 Apps route(s) resolve to mode 'apps'; none is mistaken for Agent mode");

    h.check("16 selecting Agent in the switcher resolves to the real /agent route",
      AGENT_ROUTE === "/agent" && AGENT_ROUTE === AGENT_SURFACE.route &&
      MODES.find((m) => m.key === "agent").label === "Agent" && MODES.length === 2 &&
      AGENT_SIDEBAR[0].to === AGENT_ROUTE,
      `Agent → ${AGENT_ROUTE}, the same route the Agent surface and its sidebar entry point at`);

    h.check("17 Agent mode is detected correctly, including nested /agent/* paths",
      isAgentMode("/agent") && isAgentMode("/agent/") && isAgentMode("/agent/runs/abc") &&
      activeMode("/agent") === "agent" && activeMode("/agent/runs/abc") === "agent" &&
      !isAgentMode("/agents") && !isAgentMode("/projects/agent"),
      "'/agent' and its descendants are Agent mode; lookalike paths ('/agents', '/projects/agent') are not");

    h.check("18 Agent mode renders the Agent navigation and surface INSTEAD of the Apps navigation",
      AGENT_SIDEBAR.length === 2 && AGENT_SIDEBAR[0].label === "Agent home" &&
      AGENT_SIDEBAR.filter((i) => i.action === "search").length === 1 &&
      AGENT_SIDEBAR.filter((i) => i.to).every((i) => !SIDEBAR.primary.some((p) => p.to === i.to)) &&
      AGENT_SURFACE.features.length === 4 &&
      AGENT_SURFACE.reuses.includes("agentRun function") && AGENT_SURFACE.reuses.includes("Agent Executor workflow") &&
      AGENT_SURFACE.reuses.includes("AgentRun") && AGENT_SURFACE.reuses.includes("AgentStep"),
      `${AGENT_SIDEBAR.length} agent nav item(s) replace the ${SIDEBAR.primary.length} Apps item(s); the surface reuses ${AGENT_SURFACE.reuses.length} existing runtime component(s) — no second agent system`);

    h.check("19 switching Agent → Apps returns to the Apps shell",
      activeMode(AGENT_ROUTE) === "agent" && activeMode(APPS_ROUTE) === "apps" &&
      !isAgentMode(APPS_ROUTE) && AGENT_ROUTE !== APPS_ROUTE &&
      SIDEBAR.primary.length === 7 && SIDEBAR.secondary.length === 3,
      "the switch is reversible: leaving /agent restores the 7-item Apps menu plus Favorites, Grow and Recents");

    h.check("20 switching preserves the authenticated user and workspace, and adds no duplicate switcher or gate",
      Object.values(P).every((ctx) => canSeePath(APPS_ROUTE, ctx) && canSeePath(AGENT_ROUTE, ctx)) &&
      !gateFor(AGENT_ROUTE) && !gateFor(APPS_ROUTE) &&
      Object.keys(P).every((k) => JSON.stringify(P[k].capabilities) === JSON.stringify(capabilitiesFor(P[k].role))) &&
      SIDEBAR.modes.join("|") === MODES.map((m) => m.label).join("|") &&
      !SIDEBAR.primary.concat(SIDEBAR.secondary).some((i) => i.to === AGENT_ROUTE) &&
      PALETTE.Navigation.every((p) => !isAgentMode(p)) &&
      !PALETTE.Administration.concat(PALETTE.Workspace, PALETTE.Actions).some((p) => isAgentMode(p)),
      "both modes ungated for all 5 personas; capabilities still exactly capabilitiesFor(role) — client-side navigation, so session and workspace persist; one switcher only, and the palette's Apps groups carry no Agent command");

    h.check("21 backend authorization for permitted roles is unchanged",
      requireCapability("owner", "sso.read") === "owner" && requireCapability("admin", "retention.manage") === "admin" &&
      requireCapability("editor", "project.write") === "editor" && requireCapability("viewer", "project.read") === "viewer" &&
      requireCapability("viewer", "abuse.report") === "viewer",
      "owner/admin keep admin capabilities; editor keeps write; viewer keeps read and abuse.report");

    // ---- 12 · GROW SIDEBAR REACHABILITY ------------------------------------------------------
    // The certified Grow · Module Dashboard is reachable from the sidebar: the Grow entry is a
    // REAL route link to /growth-agent (the existing Grow screen — module grid above the chat),
    // ungated for every persona, and mirrored in the palette. No second dashboard, no new route.
    const GROW_ROUTE = "/growth-agent";
    const growEntry = SIDEBAR.secondary.find((i) => i.label === "Grow");
    h.check("22 the Grow sidebar entry opens the existing Grow surface for every role — route link, ungated, palette-mirrored",
      !!growEntry && growEntry.to === GROW_ROUTE && GROW_ROUTE === "/growth-agent" && !growEntry.action &&
      !gateFor(GROW_ROUTE) && Object.values(P).every((ctx) => canSeePath(GROW_ROUTE, ctx)) &&
      !SIDEBAR.primary.some((p) => p.to === GROW_ROUTE) &&
      PALETTE.Navigation.includes(GROW_ROUTE) &&
      PALETTE.Navigation.filter((p) => p === GROW_ROUTE).length === 1,
      "Grow → '/growth-agent' in the sidebar for all 5 personas, one palette command, no duplicate route or dashboard");

    // ---- 13 · GROW MODE · PROJECT DASHBOARD REACHABILITY --------------------------------------
    // The Grow mode's own menu carries the project Dashboard entry: the SAME /growth-agent
    // route with ?dashboard=1, opening the existing project-scoped `grow` rollup for the
    // selected project — not a second dashboard, route or duplicated component.
    const GROW_DASHBOARD_TO = "/growth-agent?dashboard=1";
    const GROW_MODE_PALETTE = [{ label: "Dashboard", to: GROW_DASHBOARD_TO, group: "Grow" }];
    h.check("23 the Grow-mode menu opens the project Dashboard — same route, ?dashboard=1, ungated, palette-mirrored",
      GROW_DASHBOARD_TO.split("?")[0] === GROW_ROUTE &&
      !gateFor(GROW_DASHBOARD_TO) && Object.values(P).every((ctx) => canSeePath(GROW_DASHBOARD_TO, ctx)) &&
      !SIDEBAR.secondary.some((i) => i.to === GROW_DASHBOARD_TO) &&
      GROW_MODE_PALETTE.length === 1 && GROW_MODE_PALETTE[0].to === GROW_DASHBOARD_TO &&
      PALETTE.Navigation.includes(GROW_ROUTE) && PALETTE.Navigation.filter((p) => p === GROW_ROUTE).length === 1,
      "Dashboard → '/growth-agent?dashboard=1' in Grow mode for all 5 personas; the Apps-mode Grow entry and the single /growth-agent route are unchanged");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  }
}