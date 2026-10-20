import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Plus, Loader2, Power, AlertTriangle, Users, UserX } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useEnterpriseOrg, useScimRecords } from "@/hooks/useEnterprise";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import ScimUserRow from "@/components/enterprise/ScimUserRow";
import ScimProvisionForm from "@/components/enterprise/ScimProvisionForm";
import ConfirmDialog from "@/components/enterprise/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

export default function EnterpriseScim() {
  const { workspace, capabilities } = useWorkspace();
  const org = useEnterpriseOrg(workspace?.id);
  const scim = useScimRecords(workspace?.id);
  const [showForm, setShowForm] = useState(false);
  const [toggleOpen, setToggleOpen] = useState(false);
  const [filter, setFilter] = useState("all");

  const canManage = (capabilities || []).includes("scim.manage");

  // Reload with status filter
  useEffect(() => {
    if (filter === "all") scim.reload({ resource_type: "user" });
    else scim.reload({ resource_type: "user", status: filter });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const handleProvision = async (params) => {
    const res = await scim.provisionUser(params);
    toast({ title: res.duplicate ? "User updated" : "User provisioned", description: `${res.record.email} — role: ${res.record.mapped_role}` });
  };

  const handleSuspend = async (externalId) => {
    await scim.suspendUser(externalId);
    toast({ title: "User suspended" });
  };

  const handleDeprovision = async (externalId) => {
    await scim.deprovisionUser(externalId);
    toast({ title: "User deprovisioned", description: "Workspace access has been removed." });
  };

  const toggleScim = async () => {
    await org.update({ scim_enabled: !org.org.scim_enabled });
    setToggleOpen(false);
    toast({ title: org.org.scim_enabled ? "SCIM disabled" : "SCIM enabled" });
  };

  if (org.loading || scim.loading) return <AccountPage loading title="SCIM" subtitle="Automated user provisioning and lifecycle management."><div /></AccountPage>;

  if (!org.org) return (
    <AccountPage title="SCIM" subtitle="Automated user provisioning and lifecycle management.">
      <EmptyState icon={RefreshCw} title="No organization" description="Create an organization first to use SCIM." action={<Button asChild><Link to="/enterprise">Go to organization</Link></Button>} />
    </AccountPage>
  );

  if (scim.error) return (
    <AccountPage title="SCIM" subtitle="Automated user provisioning and lifecycle management.">
      <ErrorState message={scim.error} onRetry={() => scim.reload({ resource_type: "user" })} />
    </AccountPage>
  );

  const users = scim.records.filter((r) => r.resource_type === "user");

  return (
    <AccountPage
      title="SCIM"
      subtitle="Automated user provisioning and lifecycle management. Provisioned users must have an email on a verified domain."
      actions={canManage && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setToggleOpen(true)}>
            <Power className="h-3.5 w-3.5 mr-1.5" />{org.org.scim_enabled ? "Disable SCIM" : "Enable SCIM"}
          </Button>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            {showForm ? <Loader2 className="h-3.5 w-3.5 mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
            {showForm ? "Cancel" : "Provision user"}
          </Button>
        </div>
      )}
    >
      {/* SCIM status */}
      <div className="rounded-xl border border-border p-4">
        <div className="flex items-start gap-3">
          <Power className={`h-5 w-5 shrink-0 mt-0.5 ${org.org.scim_enabled ? "text-emerald-600" : "text-muted-foreground"}`} />
          <div className="flex-1">
            <h3 className="font-medium text-[14px]">SCIM Provisioning</h3>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {org.org.scim_enabled
                ? "SCIM is enabled. Provisioned users are created as workspace members with a role resolved from group mappings (or the org default)."
                : "SCIM is disabled. Enable it to allow user provisioning from your identity provider."}
            </p>
            {!org.org.scim_enabled && canManage && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600"><AlertTriangle className="h-3.5 w-3.5" />Provisioning is paused until SCIM is enabled.</p>
            )}
          </div>
        </div>
      </div>

      {/* Provision form */}
      {showForm && org.org.scim_enabled && (
        <div className="mt-4">
          <ScimProvisionForm onProvision={handleProvision} working={scim.working} />
        </div>
      )}

      {/* Users list */}
      <div className="mt-6">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-[14px] font-semibold">Provisioned Users</h3>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="h-7 rounded-md border border-input bg-background px-2 text-[12px]">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="deprovisioned">Deprovisioned</option>
          </select>
          <span className="ml-auto text-[12px] text-muted-foreground">{users.length} user{users.length === 1 ? "" : "s"}</span>
        </div>
        {users.length === 0 ? (
          <EmptyState icon={Users} title="No provisioned users" description={org.org.scim_enabled ? "Provision users manually or connect your IdP to push them." : "Enable SCIM and provision users to see them here."} />
        ) : (
          <div className="space-y-2">
            {users.map((r) => <ScimUserRow key={r.id} record={r} onSuspend={handleSuspend} onDeprovision={handleDeprovision} working={scim.working} />)}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={toggleOpen}
        onOpenChange={setToggleOpen}
        title={org.org.scim_enabled ? "Disable SCIM?" : "Enable SCIM?"}
        description={org.org.scim_enabled
          ? "New provisioning calls will be refused. Existing provisioned users keep their access."
          : "Your identity provider can push user lifecycle changes into the workspace."}
        confirmLabel={org.org.scim_enabled ? "Disable" : "Enable"}
        destructive={org.org.scim_enabled}
        working={org.working}
        onConfirm={toggleScim}
      />
    </AccountPage>
  );
}