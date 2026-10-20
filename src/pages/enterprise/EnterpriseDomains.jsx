import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Globe, Plus, Loader2 } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useEnterpriseOrg, useSsoDomains } from "@/hooks/useEnterprise";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import DomainRow from "@/components/enterprise/DomainRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";

export default function EnterpriseDomains() {
  const { workspace, capabilities } = useWorkspace();
  const org = useEnterpriseOrg(workspace?.id);
  const domains = useSsoDomains(workspace?.id);
  const [hostname, setHostname] = useState("");

  const canManage = (capabilities || []).includes("sso.manage");

  const addDomain = async (e) => {
    e.preventDefault();
    if (!hostname.trim()) return;
    try {
      await domains.create(hostname.trim());
      setHostname("");
      toast({ title: "Domain added", description: "Publish the TXT record, then verify." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not add domain", description: e.response?.data?.error || e.message });
    }
  };

  const handleVerify = async (domainId, records) => {
    const res = await domains.verify(domainId, records);
    if (res.duplicate) toast({ title: "Already verified" });
    else toast({ title: "Domain verified", description: "SSO routing is now available for this domain." });
  };

  const handleRemove = async (domainId) => {
    await domains.remove(domainId);
    toast({ title: "Domain removed" });
  };

  if (org.loading || domains.loading) return <AccountPage loading title="Domains" subtitle="Verified email domains for SSO routing."><div /></AccountPage>;

  if (!org.org) return (
    <AccountPage title="Domains" subtitle="Verified email domains for SSO routing.">
      <EmptyState icon={Globe} title="No organization" description="Create an organization first to manage domains." action={<Button asChild><Link to="/enterprise">Go to organization</Link></Button>} />
    </AccountPage>
  );

  if (domains.error) return (
    <AccountPage title="Domains" subtitle="Verified email domains for SSO routing.">
      <ErrorState message={domains.error} onRetry={domains.reload} />
    </AccountPage>
  );

  return (
    <AccountPage
      title="Domains"
      subtitle="Verify email domains to enable SSO routing. A domain serves nothing until ownership is proven via DNS."
    >
      {canManage && (
        <form onSubmit={addDomain} className="flex flex-col sm:flex-row gap-2 mb-5">
          <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="acme.com" className="flex-1 h-9" />
          <Button type="submit" disabled={domains.working || !hostname.trim()}>
            {domains.working ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
            Add domain
          </Button>
        </form>
      )}

      {domains.domains.length === 0 ? (
        <EmptyState icon={Globe} title="No domains" description="Add a domain to start the DNS verification process. SSO routing requires at least one verified domain." />
      ) : (
        <div className="space-y-3">
          {domains.domains.map((d) => <DomainRow key={d.id} domain={d} onVerify={handleVerify} onRemove={handleRemove} working={domains.working} />)}
        </div>
      )}
    </AccountPage>
  );
}