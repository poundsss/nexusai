import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ShieldCheck, FileText, Download, Flag, Database, History, AlertTriangle, ArrowRight, ShieldAlert, Clock } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useLegalDocuments, useAbuseReports, useDataSubjectRequests, useComplianceEvents } from "@/hooks/useCompliance";
import AccountPage from "@/components/shell/AccountPage";
import NavCard from "@/components/shell/NavCard";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import SuspendedBanner from "@/components/compliance/SuspendedBanner";
import { Badge } from "@/components/ui/badge";

function StatusPill({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
      {ok ? <ShieldCheck className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}{label}
    </span>
  );
}

const OverviewCard = NavCard;

export default function Compliance() {
  const { workspace, user, role, capabilities } = useWorkspace();
  const navigate = useNavigate();
  const docs = useLegalDocuments(workspace?.id);
  const abuse = useAbuseReports(workspace?.id);
  const dsrs = useDataSubjectRequests(workspace?.id);
  const events = useComplianceEvents(workspace?.id);

  const canReadCompliance = (capabilities || []).includes("compliance.read");
  const canModerateAbuse = (capabilities || []).includes("abuse.moderate");
  const canManageRetention = (capabilities || []).includes("retention.manage");
  const canManageBreaches = (capabilities || []).includes("breach.manage");

  const isSuspended = workspace?.status === "suspended";
  const activeDocs = docs.documents.filter((d) => d.status === "active");
  const pendingCount = docs.pending.length;
  const openReports = abuse.reports.filter((r) => !["actioned", "dismissed"].includes(r.status));
  const openDsrs = dsrs.dsrs.filter((d) => !["completed", "rejected", "expired"].includes(d.status));

  const handleAppeal = () => {
    navigate("/compliance/abuse");
  };

  if (docs.loading) return <AccountPage loading title="Compliance & Trust" subtitle="Legal, privacy, and trust management."><div /></AccountPage>;

  return (
    <AccountPage
      title="Compliance & Trust"
      subtitle="Legal documents, privacy controls, abuse reporting, and audit trail."
    >
      {/* Suspension banner */}
      {isSuspended && <div className="mb-4"><SuspendedBanner workspaceName={workspace?.name} onAppeal={handleAppeal} /></div>}

      {/* Trust & Safety status */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <span className={`h-9 w-9 rounded-md grid place-items-center shrink-0 ${isSuspended ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"}`}>
            {isSuspended ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
          </span>
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold tracking-tight">Trust &amp; Safety</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill ok={!isSuspended} label={isSuspended ? "Suspended" : "Active"} />
              <StatusPill ok={pendingCount === 0} label={pendingCount === 0 ? "Terms up to date" : `${pendingCount} pending acceptance`} />
              {canModerateAbuse && <StatusPill ok={openReports.length === 0} label={openReports.length === 0 ? "No open reports" : `${openReports.length} open reports`} />}
              {canReadCompliance && <StatusPill ok={openDsrs.length === 0} label={openDsrs.length === 0 ? "No open DSRs" : `${openDsrs.length} open DSRs`} />}
            </div>
          </div>
        </div>
      </div>

      {/* Overview cards */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard icon={FileText} title="Legal Documents" to="/compliance/legal"
          status={<Badge variant="outline" className="text-[10px] ml-1">{activeDocs.length} active</Badge>}>
          {pendingCount > 0
            ? <span className="text-amber-600 font-medium">{pendingCount} document{pendingCount > 1 ? "s" : ""} need your acceptance</span>
            : `${activeDocs.length} active document${activeDocs.length !== 1 ? "s" : ""}`}
        </OverviewCard>

        <OverviewCard icon={Download} title="Privacy Center" to="/compliance/privacy"
          status={canReadCompliance ? <Badge variant="outline" className="text-[10px] ml-1">{dsrs.dsrs.length} total</Badge> : undefined}>
          {canReadCompliance && openDsrs.length > 0
            ? <span className="text-amber-600 font-medium">{openDsrs.length} open request{openDsrs.length > 1 ? "s" : ""}</span>
            : "Data subject requests, export, and deletion"}
        </OverviewCard>

        <OverviewCard icon={Flag} title="Abuse Reporting" to="/compliance/abuse"
          status={canModerateAbuse && openReports.length > 0 ? <Badge variant="outline" className="text-[10px] ml-1 text-amber-600 border-amber-500/20">{openReports.length} open</Badge> : undefined}>
          {canModerateAbuse ? "Review and resolve reports" : "Report a violation"}
        </OverviewCard>

        {canManageRetention && (
          <OverviewCard icon={Database} title="Retention Policies" to="/compliance/retention">
            Data retention settings and legal minimums
          </OverviewCard>
        )}

        {canReadCompliance && (
          <OverviewCard icon={History} title="Audit Trail" to="/compliance/audit"
            status={<Badge variant="outline" className="text-[10px] ml-1">{events.events.length} events</Badge>}>
            Compliance event history
          </OverviewCard>
        )}

        {canManageBreaches && (
          <OverviewCard icon={AlertTriangle} title="Data Breaches" to="/compliance/breaches">
            Breach response and notification tracking
          </OverviewCard>
        )}
      </div>

      {/* Pending acceptances */}
      {pendingCount > 0 && (
        <div className="mt-6">
          <h3 className="text-[14px] font-semibold mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            Pending Acceptances
          </h3>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-[13px] text-amber-900 dark:text-amber-200">
              You have {pendingCount} document{pendingCount > 1 ? "s" : ""} that need your acceptance.{" "}
              <Link to="/compliance/legal" className="font-medium underline">Review and accept →</Link>
            </p>
          </div>
        </div>
      )}
    </AccountPage>
  );
}