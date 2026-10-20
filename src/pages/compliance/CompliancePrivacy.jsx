import React from "react";
import { Download, Clock, Shield } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useDataSubjectRequests, useLegalDocuments } from "@/hooks/useCompliance";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import DsrForm from "@/components/compliance/DsrForm";
import DsrRow from "@/components/compliance/DsrRow";
import LegalDocumentCard from "@/components/compliance/LegalDocumentCard";
import { toast } from "@/components/ui/use-toast";

export default function CompliancePrivacy() {
  const { workspace, user, capabilities } = useWorkspace();
  const dsrs = useDataSubjectRequests(workspace?.id);
  const docs = useLegalDocuments(workspace?.id);
  const canManageDsr = (capabilities || []).includes("dsr.manage");

  const handleFile = async (params) => {
    const res = await dsrs.file(params);
    return res;
  };

  if (dsrs.loading) return <AccountPage loading title="Privacy Center" subtitle="Data subject requests, export, and deletion."><div /></AccountPage>;
  if (dsrs.error && !dsrs.dsrs.length) return <AccountPage title="Privacy Center" subtitle="Data subject requests, export, and deletion."><ErrorState message={dsrs.error} onRetry={dsrs.reload} /></AccountPage>;

  const activeDocs = docs.documents.filter((d) => d.status === "active");
  const pendingIds = new Set(docs.pending.map((d) => d.id));

  return (
    <AccountPage
      title="Privacy Center"
      subtitle="Manage your personal data: request access, export, correction, or deletion. All requests are verified by email before proceeding."
    >
      {/* Privacy info */}
      <div className="rounded-xl border border-border bg-muted/30 p-4">
        <div className="flex items-start gap-3">
          <Shield className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-[13px] text-muted-foreground">
            <p className="font-medium text-foreground">Your data rights</p>
            <p className="mt-1">Under GDPR and CCPA, you have the right to access, export, correct, restrict, object to, or delete the personal data we hold about you. Every request is verified by email before any data is released or modified.</p>
            <p className="mt-1.5">Requests are fulfilled within 30 days. Deletion is irreversible — a verified deletion request permanently erases your data from this workspace.</p>
          </div>
        </div>
      </div>

      {/* DSR Form */}
      <div className="mt-5">
        <DsrForm onFile={handleFile} working={dsrs.working} defaultEmail={user?.email} />
      </div>

      {/* Existing requests */}
      <div className="mt-6">
        <h3 className="text-[14px] font-semibold mb-3 flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Your Requests
        </h3>
        {dsrs.dsrs.length === 0 ? (
          <EmptyState icon={Download} title="No data subject requests" description="Submit a request above to get started. You'll receive a verification email to confirm." />
        ) : (
          <div className="space-y-2">
            {dsrs.dsrs.map((dsr) => (
              <DsrRow key={dsr.id} dsr={dsr} onVerify={dsrs.verify} working={dsrs.working} canManage={canManageDsr} onComplete={dsrs.complete} onReject={dsrs.reject} />
            ))}
          </div>
        )}
      </div>

      {/* Legal documents */}
      {activeDocs.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[14px] font-semibold mb-3">Applicable Legal Documents</h3>
          <div className="space-y-3">
            {activeDocs.map((doc) => (
              <LegalDocumentCard key={doc.id} doc={doc} accepted={!pendingIds.has(doc.id)} onAccept={async (id) => { try { await docs.accept(id); toast({ title: "Document accepted" }); } catch (e) { toast({ variant: "destructive", title: "Could not accept", description: e.response?.data?.error || e.message }); } }} working={docs.working} />
            ))}
          </div>
        </div>
      )}
    </AccountPage>
  );
}