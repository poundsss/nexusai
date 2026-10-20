// THE single source of navigation visibility.
//
// Both the sidebar and the command palette read their gates from here, so the two surfaces can
// never disagree about what a role may see. This module introduces NO role logic of its own: it
// only reads the two values the server already resolved — the platform `user.role` and the
// workspace `capabilities` array produced by rbac.capabilitiesFor() — plus the server-resolved
// effective-plan `entitlements`/`tier_rank` for the few routes that are plan-gated. Visibility is
// presentation only; the server re-authorizes every request and still answers 402/403 on its own.

export const hasCapability = (capabilities, capability) => (capabilities || []).includes(capability);

// Platform administration is a PLATFORM role, not a workspace role.
export const isPlatformAdmin = (user) => user?.role === "admin";

// Route → the access it requires. A route that is absent from this map is available to every
// authenticated member (Home, Projects, Billing, the public legal pages, …).
//   capability:  the existing server-side workspace capability the backend already enforces.
//   entitlement: an EXISTING plan.entitlements flag (sso | scim | audit_export) — the route is
//                hidden when the effective plan does not include it. Presentation only; the
//                backend re-checks via planLimits.assert{Sso,Scim,AuditExport}Entitlement.
//   minTier:     a Builder+ tier boundary (tier_rank) — the route is hidden below it. Used for
//                mobile store-file surfaces (DOCUMENTED Base44: Builder+ to download store files).
const GATED_ROUTES = [
  { prefix: "/admin", platformAdmin: true },
  // /enterprise/scim must precede /enterprise so the SCIM-specific gate wins on that exact path.
  { prefix: "/enterprise/scim", capability: "sso.read", entitlement: "scim" },
  { prefix: "/enterprise", capability: "sso.read", entitlement: "sso" },
  { prefix: "/compliance/audit", capability: "compliance.read", entitlement: "audit_export" },
  { prefix: "/compliance/retention", capability: "retention.manage" },
  { prefix: "/compliance/breaches", capability: "breach.manage" },
  // Builder/admin surfaces in the sidebar PRIMARY. Each maps to the existing server-side
  // capability the backend already enforces (rbac.capabilitiesFor), so a member who lacks the
  // capability never sees the entry — and the backend still answers 403 if they hit the URL.
  // Mobile store-file surfaces are Builder+ gated (DOCUMENTED Base44).
  { prefix: "/marketplace/moderation", capability: "marketplace.moderate" },
  { prefix: "/mobile-admin", capability: "secret.manage", minTier: 6 },
  { prefix: "/publisher", capability: "marketplace.publish" },
  { prefix: "/api-access", capability: "secret.manage" },
  { prefix: "/transfers", capability: "workspace.manage" },
  { prefix: "/connections", capability: "integration.manage" },
  { prefix: "/mcp", capability: "integration.manage" },
];

const gateFor = (path) =>
  GATED_ROUTES.find((g) => path === g.prefix || path.startsWith(g.prefix + "/")) || null;

/** Whether this user may SEE a navigation entry pointing at `path`. */
export function canSeePath(path, { user, capabilities, plan, entitlements } = {}) {
  const gate = gateFor(String(path || ""));
  if (!gate) return true;
  if (gate.platformAdmin) return isPlatformAdmin(user);
  if (!hasCapability(capabilities, gate.capability)) return false;
  // Plan-entitlement gates (presentation only; the backend re-authorizes). When the flag is
  // absent/false the entry is hidden. `entitlements` is {} before the billing overview resolves,
  // so plan-gated entries stay hidden until the plan loads (fail-closed for visibility).
  if (gate.entitlement && !(entitlements || {})[gate.entitlement]) return false;
  if (gate.minTier) {
    const tier = Number(plan?.tier_rank ?? -1);
    if (!Number.isFinite(tier) || tier < gate.minTier) return false;
  }
  return true;
}

/** True when the user holds at least one administrative entry — the Administration section's gate. */
export function hasAnyAdminAccess({ user, capabilities, plan, entitlements }) {
  return GATED_ROUTES.some((g) => canSeePath(g.prefix, { user, capabilities, plan, entitlements }));
}