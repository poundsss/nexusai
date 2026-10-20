import React from "react";
import { History, ShieldCheck } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useComplianceEvents } from "@/hooks/useCompliance";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import ComplianceEventRow from "@/components/compliance/ComplianceEventRow";

export default function ComplianceAudit() {
  const { workspace } = useWorkspace();
  const events = useComplianceEvents(workspace?.id);

  if (events.loading) return <AccountPage loading title="Audit Trail" subtitle="Compliance event history."><div /></AccountPage>;
  if (events.error) return <AccountPage title="Audit Trail" subtitle="Compliance event history."><ErrorState message={events.error} onRetry={events.reload} /></AccountPage>;

  return (
    <AccountPage
      title="Audit Trail"
      subtitle="A chronological record of compliance events: acceptances, DSRs, breaches, retention changes, and data exports."
    >
      {events.events.length === 0 ? (
        <EmptyState icon={History} title="No compliance events" description="When compliance events occur — terms accepted, DSRs filed, breaches reported — they appear here." />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          {events.events.map((event) => <ComplianceEventRow key={event.id} event={event} />)}
        </div>
      )}
    </AccountPage>
  );
}