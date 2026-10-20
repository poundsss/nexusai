import React, { useState } from "react";
import { Link } from "react-router-dom";
import { KeyRound, Loader2 } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useEnterpriseOrg, useGroupMappings } from "@/hooks/useEnterprise";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import GroupMappingForm from "@/components/enterprise/GroupMappingForm";
import GroupMappingRow from "@/components/enterprise/GroupMappingRow";
import { toast } from "@/components/ui/use-toast";

export default function EnterpriseGroups() {
  const { workspace, capabilities } = useWorkspace();
  const org = useEnterpriseOrg(workspace?.id);
  const mappings = useGroupMappings(workspace?.id);

  const canManage = (capabilities || []).includes("sso.manage");

  const handleCreate = async (params) => {
    await mappings.create(params);
    toast({ title: "Group mapping created" });
  };

  const handleRemove = async (mappingId) => {
    await mappings.remove(mappingId);
    toast({ title: "Group mapping removed" });
  };

  if (org.loading || mappings.loading) return <AccountPage loading title="Group Mappings" subtitle="Map identity provider groups to workspace roles."><div /></AccountPage>;

  if (!org.org) return (
    <AccountPage title="Group Mappings" subtitle="Map identity provider groups to workspace roles.">
      <EmptyState icon={KeyRound} title="No organization" description="Create an organization first to manage group mappings." action={<Link to="/enterprise" className="text-primary hover:underline text-[13px]">Go to organization</Link>} />
    </AccountPage>
  );

  if (mappings.error) return (
    <AccountPage title="Group Mappings" subtitle="Map identity provider groups to workspace roles.">
      <ErrorState message={mappings.error} onRetry={mappings.reload} />
    </AccountPage>
  );

  return (
    <AccountPage
      title="Group Mappings"
      subtitle="Map identity provider groups to workspace roles. The highest-priority matching mapping wins; ties break by role rank (admin > editor > viewer)."
    >
      {canManage && <div className="mb-5"><GroupMappingForm onCreate={handleCreate} working={mappings.working} /></div>}

      {mappings.mappings.length === 0 ? (
        <EmptyState icon={KeyRound} title="No group mappings" description="Create a mapping so users from a specific IdP group automatically get the right role when they sign in or are provisioned." />
      ) : (
        <div className="space-y-2">
          {mappings.mappings.map((m) => <GroupMappingRow key={m.id} mapping={m} onRemove={handleRemove} working={mappings.working} />)}
        </div>
      )}
    </AccountPage>
  );
}