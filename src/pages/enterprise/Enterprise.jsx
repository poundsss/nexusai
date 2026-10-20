import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Loader2, ShieldCheck, Globe, RefreshCw, Users, KeyRound, Lock, Plus, ArrowRight, CheckCircle2, XCircle, Ban, Power } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useEnterpriseOrg, useSsoConnections, useSsoDomains, useScimRecords } from "@/hooks/useEnterprise";
import AccountPage from "@/components/shell/AccountPage";
import NavCard from "@/components/shell/NavCard";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import CreateOrgDialog from "@/components/enterprise/CreateOrgDialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

function StatusPill({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}{label}
    </span>
  );
}

const OverviewCard = NavCard;

export default function Enterprise() {
  const { workspace, role, capabilities } = useWorkspace();
  const org = useEnterpriseOrg(workspace?.id);
  const connections = useSsoConnections(workspace?.id);
  const domains = useSsoDomains(workspace?.id);
  const scim = useScimRecords(workspace?.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  const canManage = (capabilities || []).includes("sso.manage");

  const handleCreate = async (params) => {
    await org.create(params);
    toast({ title: "Organization created", description: "You can now configure SSO, domains, and SCIM." });
  };

  // Suspend / reinstate the organization through the existing certified `sso` actions. Both are
  // admin-only (sso.manage) and confirmed; the returned organization/status fields are shown
  // verbatim via the existing org.reload. No new status or policy is invented.
  const suspendOrg = async () => {
    if (!workspace?.id) return;
    const reason = prompt("Suspend this organization? Members lose SSO/SCIM access. Enter a reason:") ;
    if (reason === null) return;
    if (!confirm("Confirm suspension.")) return;
    setLifecycleBusy(true);
    try {
      await base44.functions.invoke("sso", { action: "suspend_org", workspace_id: workspace.id, reason: reason || null });
      toast({ title: "Organization suspended" });
      await org.reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Suspend failed", description: e.response?.data?.error || e.message });
    } finally { setLifecycleBusy(false); }
  };

  const reinstateOrg = async () => {
    if (!workspace?.id) return;
    if (!confirm("Reinstate this organization? SSO and SCIM resume.")) return;
    setLifecycleBusy(true);
    try {
      await base44.functions.invoke("sso", { action: "reinstate_org", workspace_id: workspace.id });
      toast({ title: "Organization reinstated" });
      await org.reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Reinstate failed", description: e.response?.data?.error || e.message });
    } finally { setLifecycleBusy(false); }
  };

  if (org.loading) return <AccountPage loading title="Enterprise" subtitle="Organization, identity, and access management."><div /></AccountPage>;

  if (org.error && !org.org) return (
    <AccountPage title="Enterprise" subtitle="Organization, identity, and access management.">
      <ErrorState message={org.error} onRetry={org.reload} />
    </AccountPage>
  );

  if (!org.org) {
    return (
      <AccountPage
        title="Enterprise"
        subtitle="Organization, identity, and access management."
        actions={canManage && <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" />Create organization</Button>}
      >
        <EmptyState
          icon={Building2}
          title="No organization yet"
          description="Create an organization to configure SSO, verify domains, map groups, and provision users through SCIM."
          action={canManage && <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" />Create organization</Button>}
        />
        <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={handleCreate} working={org.working} />
      </AccountPage>
    );
  }

  const activeConnections = connections.connections.filter((c) => c.status === "active");
  const verifiedDomains = domains.domains.filter((d) => d.status === "verified");
  const activeScimUsers = scim.records.filter((r) => r.resource_type === "user" && r.status === "active");

  return (
    <AccountPage
      title="Enterprise"
      subtitle="Organization, identity, and access management."
      actions={<Button variant="outline" size="sm" onClick={org.reload}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh</Button>}
    >
      {/* Org header */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <span className="h-9 w-9 rounded-md bg-muted text-foreground grid place-items-center shrink-0"><Building2 className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-tight">{org.org.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusPill ok={org.org.status === "active"} label={org.org.status} />
              <StatusPill ok={org.org.sso_enforced} label={org.org.sso_enforced ? "SSO enforced" : "SSO not enforced"} />
              <StatusPill ok={org.org.scim_enabled} label={org.org.scim_enabled ? "SCIM enabled" : "SCIM disabled"} />
              <span className="text-[11px] text-muted-foreground">default role: <span className="font-medium text-foreground">{org.org.default_role}</span></span>
              {org.org.max_seats > 0 && <span className="text-[11px] text-muted-foreground">max seats: <span className="font-medium text-foreground">{org.org.max_seats}</span></span>}
            </div>
          </div>
          {canManage && (
            <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
              {org.org.status === "active" ? (
                <Button variant="outline" size="sm" onClick={suspendOrg} disabled={lifecycleBusy}>
                  {lifecycleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}Suspend organization
                </Button>
              ) : org.org.status === "suspended" ? (
                <Button variant="outline" size="sm" onClick={reinstateOrg} disabled={lifecycleBusy}>
                  {lifecycleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}Reinstate organization
                </Button>
              ) : null}
              {org.org.status === "suspended" && <span className="text-[11.5px] text-amber-600">Suspended — SSO and SCIM are inactive until reinstated.</span>}
            </div>
          )}
        </div>
      </div>

      {/* Overview cards */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard icon={ShieldCheck} title="SSO Connections" to="/enterprise/sso" status={<StatusPill ok={activeConnections.length > 0} label={`${activeConnections.length} active`} />}>
          {connections.loading ? "Loading…" : activeConnections.length === 0 ? "No active SSO connections" : `${activeConnections.length} SAML/OIDC connection${activeConnections.length > 1 ? "s" : ""}`}
        </OverviewCard>
        <OverviewCard icon={Globe} title="Verified Domains" to="/enterprise/domains" status={<StatusPill ok={verifiedDomains.length > 0} label={`${verifiedDomains.length} verified`} />}>
          {domains.loading ? "Loading…" : verifiedDomains.length === 0 ? "No verified domains" : `${verifiedDomains.length} of ${domains.domains.length} domain${domains.domains.length > 1 ? "s" : ""} verified`}
        </OverviewCard>
        <OverviewCard icon={Users} title="Members" to="/members" status={<StatusPill ok label="Manage" />}>
          Manage workspace members, roles, and invitations.
        </OverviewCard>
        <OverviewCard icon={KeyRound} title="Group Mappings" to="/enterprise/groups" status={<StatusPill ok={false} label="Configure" />}>
          Map IdP groups to workspace roles.
        </OverviewCard>
        <OverviewCard icon={RefreshCw} title="SCIM Provisioning" to="/enterprise/scim" status={<StatusPill ok={org.org.scim_enabled} label={org.org.scim_enabled ? "Enabled" : "Disabled"} />}>
          {scim.loading ? "Loading…" : `${activeScimUsers.length} provisioned user${activeScimUsers.length === 1 ? "" : "s"}`}
        </OverviewCard>
        <OverviewCard icon={Lock} title="Security" to="/enterprise/security" status={<StatusPill ok={org.org.sso_enforced} label={org.org.sso_enforced ? "Enforced" : "Not enforced"} />}>
          SSO enforcement, domain status, and access controls.
        </OverviewCard>
      </div>

      {/* Roles link */}
      <div className="mt-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[12.5px]">Your role: <span className="font-medium">{role}</span></span>
          <Link to="/enterprise/roles" className="ml-auto text-[12px] font-medium hover:underline">Roles & permissions</Link>
        </div>
      </div>

      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={handleCreate} working={org.working} />
    </AccountPage>
  );
}