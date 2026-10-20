import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, KeyRound, Plus, Loader2, AlertTriangle, Power } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useEnterpriseOrg, useSsoConnections } from "@/hooks/useEnterprise";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import ConnectionCard from "@/components/enterprise/ConnectionCard";
import SamlConnectionForm from "@/components/enterprise/SamlConnectionForm";
import OidcConnectionForm from "@/components/enterprise/OidcConnectionForm";
import ConfirmDialog from "@/components/enterprise/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

export default function EnterpriseSso() {
  const { workspace, capabilities } = useWorkspace();
  const org = useEnterpriseOrg(workspace?.id);
  const conns = useSsoConnections(workspace?.id);
  const [samlOpen, setSamlOpen] = useState(false);
  const [oidcOpen, setOidcOpen] = useState(false);
  const [enforceOpen, setEnforceOpen] = useState(false);

  const canManage = (capabilities || []).includes("sso.manage");

  const handleCreateSaml = async (params) => {
    await conns.create(params);
    toast({ title: "SAML connection created", description: "The certificate is encrypted at rest." });
  };

  const handleCreateOidc = async (params) => {
    await conns.create(params);
    toast({ title: "OIDC connection created", description: "The client secret is encrypted at rest." });
  };

  const handleDisable = async (connectionId) => {
    await conns.disable(connectionId);
    toast({ title: "Connection disabled" });
  };

  const toggleEnforcement = async () => {
    await org.update({ sso_enforced: !org.org.sso_enforced });
    setEnforceOpen(false);
    toast({ title: org.org.sso_enforced ? "SSO enforcement disabled" : "SSO enforcement enabled" });
  };

  if (org.loading || conns.loading) return <AccountPage loading title="SSO Configuration" subtitle="SAML and OIDC identity provider connections."><div /></AccountPage>;

  if (!org.org) return (
    <AccountPage title="SSO Configuration" subtitle="SAML and OIDC identity provider connections.">
      <EmptyState icon={ShieldCheck} title="No organization" description="Create an organization first to configure SSO." action={<Button asChild><Link to="/enterprise">Go to organization</Link></Button>} />
    </AccountPage>
  );

  if (conns.error) return (
    <AccountPage title="SSO Configuration" subtitle="SAML and OIDC identity provider connections.">
      <ErrorState message={conns.error} onRetry={conns.reload} />
    </AccountPage>
  );

  return (
    <AccountPage
      title="SSO Configuration"
      subtitle="SAML and OIDC identity provider connections. Certificates and secrets are encrypted at rest and never displayed."
      actions={canManage && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setSamlOpen(true)}><ShieldCheck className="h-3.5 w-3.5 mr-1.5" />Add SAML</Button>
          <Button variant="outline" size="sm" onClick={() => setOidcOpen(true)}><KeyRound className="h-3.5 w-3.5 mr-1.5" />Add OIDC</Button>
        </div>
      )}
    >
      {/* SSO Enforcement */}
      <div className="rounded-xl border border-border p-4">
        <div className="flex items-start gap-3">
          <Power className={`h-5 w-5 shrink-0 mt-0.5 ${org.org.sso_enforced ? "text-emerald-600" : "text-muted-foreground"}`} />
          <div className="flex-1">
            <h3 className="font-medium text-[14px]">SSO Enforcement</h3>
            <p className="mt-1 text-[12px] text-muted-foreground">
              When enabled, users with email addresses on verified domains <span className="font-medium text-foreground">must</span> sign in through SSO — password login is refused for them. Enable only after verifying at least one domain and confirming the SSO connection works.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${org.org.sso_enforced ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                {org.org.sso_enforced ? "Enforced" : "Not enforced"}
              </span>
              {canManage && (
                <Button variant={org.org.sso_enforced ? "outline" : "default"} size="sm" onClick={() => setEnforceOpen(true)}>
                  {org.org.sso_enforced ? "Disable enforcement" : "Enable enforcement"}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Connections */}
      <div className="mt-6">
        <h3 className="text-[14px] font-semibold mb-3">Connections</h3>
        {conns.connections.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No SSO connections"
            description="Add a SAML or OIDC connection to let users sign in through your identity provider."
            action={canManage && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setSamlOpen(true)}><ShieldCheck className="h-3.5 w-3.5 mr-1.5" />Add SAML</Button><Button size="sm" variant="outline" onClick={() => setOidcOpen(true)}><KeyRound className="h-3.5 w-3.5 mr-1.5" />Add OIDC</Button></div>}
          />
        ) : (
          <div className="space-y-3">
            {conns.connections.map((c) => <ConnectionCard key={c.id} connection={c} onDisable={handleDisable} working={conns.working} />)}
          </div>
        )}
      </div>

      <SamlConnectionForm open={samlOpen} onOpenChange={setSamlOpen} onCreate={handleCreateSaml} working={conns.working} />
      <OidcConnectionForm open={oidcOpen} onOpenChange={setOidcOpen} onCreate={handleCreateOidc} working={conns.working} />
      <ConfirmDialog
        open={enforceOpen}
        onOpenChange={setEnforceOpen}
        title={org.org.sso_enforced ? "Disable SSO enforcement?" : "Enable SSO enforcement?"}
        description={org.org.sso_enforced
          ? "Users on verified domains will be able to sign in with a password again. This reduces security but does not lock anyone out."
          : "Users on verified domains will be required to sign in through SSO. Make sure at least one domain is verified and the SSO connection works, or users could be locked out."}
        confirmLabel={org.org.sso_enforced ? "Disable" : "Enable enforcement"}
        destructive={!org.org.sso_enforced}
        working={org.working}
        onConfirm={toggleEnforcement}
      />
    </AccountPage>
  );
}