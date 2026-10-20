import React from "react";
import { Flag, Clock } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useAbuseReports } from "@/hooks/useCompliance";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import AbuseReportForm from "@/components/compliance/AbuseReportForm";
import AbuseReportRow from "@/components/compliance/AbuseReportRow";

export default function ComplianceAbuse() {
  const { workspace, capabilities } = useWorkspace();
  const abuse = useAbuseReports(workspace?.id);
  const canModerate = (capabilities || []).includes("abuse.moderate");

  if (abuse.loading) return <AccountPage loading title="Abuse Reporting" subtitle="Report violations and track their resolution."><div /></AccountPage>;

  return (
    <AccountPage
      title="Abuse Reporting"
      subtitle="Report a violation or, if you're a moderator, review and resolve reports."
    >
      {/* Report form — available to everyone */}
      <AbuseReportForm onFile={abuse.file} working={abuse.working} />

      {/* Moderator view */}
      {canModerate && (
        <div className="mt-6">
          <h3 className="text-[14px] font-semibold mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Reports Queue
          </h3>
          {abuse.error ? (
            <ErrorState message={abuse.error} onRetry={abuse.reload} />
          ) : abuse.reports.length === 0 ? (
            <EmptyState icon={Flag} title="No reports" description="There are no abuse reports in the queue." />
          ) : (
            <div className="space-y-2">
              {abuse.reports.map((report) => (
                <AbuseReportRow key={report.id} report={report} onAssign={abuse.assign} onResolve={abuse.resolve} working={abuse.working} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Non-moderator info */}
      {!canModerate && (
        <div className="mt-6 rounded-lg border border-border bg-muted/30 p-4 text-[13px] text-muted-foreground">
          <p>Thank you for helping keep the platform safe. Reports are reviewed by our moderation team. You will not see moderation details, but every report is tracked and acted on according to our policies.</p>
        </div>
      )}
    </AccountPage>
  );
}