import React from "react";
import { KeyRound, ShieldCheck, Crown, Check, X } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import AccountPage from "@/components/shell/AccountPage";

// The RBAC capability matrix from base44/shared/rbac.ts, mirrored here for display only.
// The server is authoritative — this view never enforces, it only explains.
const CAPABILITIES = {
  "Project": [
    { name: "project.read", label: "View projects", roles: ["owner", "admin", "editor", "viewer"] },
    { name: "project.write", label: "Edit projects", roles: ["owner", "admin", "editor"] },
    { name: "project.create", label: "Create projects", roles: ["owner", "admin", "editor"] },
    { name: "project.delete", label: "Delete projects", roles: ["owner", "admin"] },
    { name: "version.restore", label: "Restore versions", roles: ["owner", "admin", "editor"] },
    { name: "integration.manage", label: "Manage integrations", roles: ["owner", "admin", "editor"] },
    { name: "github.manage", label: "Manage GitHub sync", roles: ["owner", "admin"] },
  ],
  "Deployment": [
    { name: "deploy.manage", label: "Deploy to production", roles: ["owner", "admin"] },
    { name: "domain.manage", label: "Manage custom domains", roles: ["owner", "admin"] },
    { name: "secret.manage", label: "Manage secrets", roles: ["owner", "admin"] },
  ],
  "Billing": [
    { name: "billing.read", label: "View billing", roles: ["owner", "admin", "editor", "viewer"] },
    { name: "billing.admin", label: "Manage billing", roles: ["owner", "admin"] },
    { name: "billing.manage", label: "Move money / change limits", roles: ["owner"] },
  ],
  "Marketplace": [
    { name: "marketplace.read", label: "Browse marketplace", roles: ["owner", "admin", "editor", "viewer"] },
    { name: "marketplace.install", label: "Install apps", roles: ["owner", "admin", "editor", "viewer"] },
    { name: "marketplace.publish", label: "Publish listings", roles: ["owner", "admin", "editor"] },
    { name: "marketplace.moderate", label: "Moderate reports", roles: ["owner", "admin"] },
  ],
  "Enterprise SSO / SCIM": [
    { name: "sso.read", label: "View SSO config", roles: ["owner", "admin"] },
    { name: "sso.manage", label: "Configure SSO", roles: ["owner", "admin"] },
    { name: "scim.manage", label: "Manage SCIM", roles: ["owner", "admin"] },
  ],
  "Compliance": [
    { name: "compliance.read", label: "View audit trail", roles: ["owner", "admin"] },
    { name: "compliance.manage", label: "Manage compliance", roles: ["owner", "admin"] },
    { name: "abuse.report", label: "File abuse reports", roles: ["owner", "admin", "editor", "viewer"] },
    { name: "abuse.moderate", label: "Moderate abuse", roles: ["owner", "admin"] },
    { name: "dsr.manage", label: "Manage data subject requests", roles: ["owner", "admin"] },
    { name: "breach.manage", label: "Manage breach response", roles: ["owner", "admin"] },
    { name: "retention.manage", label: "Manage retention policies", roles: ["owner", "admin"] },
  ],
  "Administration": [
    { name: "member.manage", label: "Manage members", roles: ["owner", "admin"] },
    { name: "workspace.manage", label: "Manage workspace", roles: ["owner"] },
  ],
};

const ROLES = ["owner", "admin", "editor", "viewer"];
const ROLE_ICONS = { owner: Crown, admin: ShieldCheck, editor: KeyRound, viewer: KeyRound };

export default function EnterpriseRoles() {
  const { role, capabilities } = useWorkspace();
  const userCaps = capabilities || [];

  return (
    <AccountPage
      title="Roles & Permissions"
      subtitle="What each workspace role can do. The server enforces these — this view is for understanding, not for granting."
    >
      {/* Your role */}
      <div className="rounded-xl border border-border bg-muted/30 p-4">
        <div className="flex items-center gap-2">
          {(() => { const Icon = ROLE_ICONS[role] || KeyRound; return <Icon className="h-4 w-4 text-muted-foreground" />; })()}
          <span className="text-[13px] font-medium">Your role: <span className="font-mono text-foreground">{role || "—"}</span></span>
          <span className="ml-auto text-[12px] text-muted-foreground">{userCaps.length} capabilities</span>
        </div>
      </div>

      {/* Capability matrix */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Capability</th>
              {ROLES.map((r) => (
                <th key={r} className="text-center py-2 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  <span className={`font-mono ${r === role ? "text-foreground font-semibold" : ""}`}>{r}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(CAPABILITIES).map(([group, caps]) => (
              <React.Fragment key={group}>
                <tr><td colSpan={ROLES.length + 1} className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">{group}</td></tr>
                {caps.map((cap) => (
                  <tr key={cap.name} className="border-b border-border/40 hover:bg-muted/30 transition-colors">
                    <td className="py-2 pr-4">
                      <div className="font-medium">{cap.label}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">{cap.name}</div>
                    </td>
                    {ROLES.map((r) => {
                      const allowed = cap.roles.includes(r);
                      const isYours = r === role;
      return <td key={r} className="text-center py-2 px-3">{allowed ? <Check className={`h-4 w-4 mx-auto ${isYours ? "text-emerald-600" : "text-muted-foreground"}`} /> : <X className="h-4 w-4 mx-auto text-muted-foreground/20" />}</td>;
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 rounded-lg bg-muted/50 border border-border p-4 text-[12px] text-muted-foreground">
        <p className="font-medium text-foreground">Role hierarchy</p>
        <ul className="mt-2 space-y-1">
          <li><span className="font-mono text-foreground">owner</span> — Derived from workspace ownership. Cannot be granted or removed. Full control including billing and workspace deletion.</li>
          <li><span className="font-mono text-foreground">admin</span> — Deploys, domains, credentials, GitHub, team and enterprise management. Cannot move money or delete the workspace.</li>
          <li><span className="font-mono text-foreground">editor</span> — Builds and edits projects. Cannot deploy, manage credentials, or invite people.</li>
          <li><span className="font-mono text-foreground">viewer</span> — Read-only access to projects.</li>
        </ul>
        <p className="mt-3 text-[11px]">Only the workspace owner can grant or modify the admin role. An admin cannot modify another admin's membership.</p>
      </div>
    </AccountPage>
  );
}