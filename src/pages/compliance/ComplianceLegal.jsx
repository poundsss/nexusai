import React, { useState, useMemo } from "react";
import { FileText, Plus, Loader2, History } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useLegalDocuments } from "@/hooks/useCompliance";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import LegalDocumentCard from "@/components/compliance/LegalDocumentCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";

const DOC_TYPES = [
  { value: "tos", label: "Terms of Service" },
  { value: "privacy_policy", label: "Privacy Policy" },
  { value: "dpa", label: "Data Processing Agreement" },
  { value: "acceptable_use", label: "Acceptable Use Policy" },
  { value: "subprocessor_list", label: "Subprocessor List" },
  { value: "cookie_policy", label: "Cookie Policy" },
];

export default function ComplianceLegal() {
  const { workspace, user, capabilities } = useWorkspace();
  const docs = useLegalDocuments(workspace?.id);
  const canManage = (capabilities || []).includes("compliance.manage");
  const [showPublish, setShowPublish] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [form, setForm] = useState({ type: "tos", version: "", title: "", content_url: "", effective_date: "" });

  const acceptedIds = useMemo(() => {
    // The pending list is what the user hasn't accepted; anything not in pending and active is accepted.
    const pendingIds = new Set(docs.pending.map((d) => d.id));
    return new Set(docs.documents.filter((d) => d.status === "active" && !pendingIds.has(d.id)).map((d) => d.id));
  }, [docs.pending, docs.documents]);

  const handleAccept = async (docId) => {
    try {
      const res = await docs.accept(docId);
      toast({ title: res.duplicate ? "Already accepted" : "Document accepted", description: "Your acceptance has been recorded." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not accept", description: e.response?.data?.error || e.message });
    }
  };

  const handleRetire = async (docId) => {
    try {
      await docs.retire(docId);
      toast({ title: "Document retired" });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not retire", description: e.response?.data?.error || e.message });
    }
  };

  const handlePublish = async (e) => {
    e.preventDefault();
    if (!form.version.trim() || !form.title.trim() || !form.content_url.trim()) {
      toast({ variant: "destructive", title: "All fields are required" });
      return;
    }
    try {
      await docs.publish({ type: form.type, version: form.version.trim(), title: form.title.trim(), content_url: form.content_url.trim(), effective_date: form.effective_date || undefined });
      setShowPublish(false);
      setForm({ type: "tos", version: "", title: "", content_url: "", effective_date: "" });
      toast({ title: "Document published", description: "The previous active version was retired." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not publish", description: e.response?.data?.error || e.message });
    }
  };

  if (docs.loading) return <AccountPage loading title="Legal Documents" subtitle="Terms, policies, and their acceptance state."><div /></AccountPage>;
  if (docs.error) return <AccountPage title="Legal Documents" subtitle="Terms, policies, and their acceptance state."><ErrorState message={docs.error} onRetry={docs.reload} /></AccountPage>;

  const activeDocs = docs.documents.filter((d) => d.status === "active");
  const retiredDocs = docs.documents.filter((d) => d.status === "retired");

  return (
    <AccountPage
      title="Legal Documents"
      subtitle="Terms of Service, Privacy Policy, and other legal documents. Each version is immutable once published."
      actions={canManage && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowHistory(!showHistory)}><History className="h-3.5 w-3.5 mr-1.5" />{showHistory ? "Hide history" : "Show history"}</Button>
          <Button size="sm" onClick={() => setShowPublish(!showPublish)}><Plus className="h-3.5 w-3.5 mr-1.5" />{showPublish ? "Cancel" : "Publish"}</Button>
        </div>
      )}
    >
      {/* Publish form */}
      {showPublish && canManage && (
        <form onSubmit={handlePublish} className="mb-5 rounded-xl border border-border bg-card p-4 space-y-3">
          <h3 className="font-medium text-[14px]">Publish New Version</h3>
          <p className="text-[12px] text-muted-foreground">Publishing a new version of a document type retires the currently active one. The old version is retained for audit.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-[12px]">Document type</Label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-[13px]">
                {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-[12px]">Version</Label>
              <Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="e.g. 2026-01-v1" className="mt-1 h-9" />
            </div>
            <div>
              <Label className="text-[12px]">Title</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Terms of Service" className="mt-1 h-9" />
            </div>
            <div>
              <Label className="text-[12px]">Content URL</Label>
              <Input value={form.content_url} onChange={(e) => setForm({ ...form, content_url: e.target.value })} placeholder="https://..." className="mt-1 h-9" />
            </div>
            <div>
              <Label className="text-[12px]">Effective date (optional)</Label>
              <Input type="date" value={form.effective_date} onChange={(e) => setForm({ ...form, effective_date: e.target.value })} className="mt-1 h-9" />
            </div>
          </div>
          <Button type="submit" size="sm" disabled={docs.working}>{docs.working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Publish version</Button>
        </form>
      )}

      {/* Active documents */}
      <h3 className="text-[14px] font-semibold mb-3">Active Documents</h3>
      {activeDocs.length === 0 ? (
        <EmptyState icon={FileText} title="No active documents" description="There are no active legal documents published yet." />
      ) : (
        <div className="space-y-3">
          {activeDocs.map((doc) => (
            <LegalDocumentCard key={doc.id} doc={doc} accepted={acceptedIds.has(doc.id)} onAccept={handleAccept} working={docs.working} canManage={canManage} onRetire={handleRetire} />
          ))}
        </div>
      )}

      {/* Historical versions */}
      {showHistory && retiredDocs.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[14px] font-semibold mb-3 flex items-center gap-2"><History className="h-4 w-4 text-muted-foreground" />Historical Versions</h3>
          <div className="space-y-2">
            {retiredDocs.map((doc) => (
              <div key={doc.id} className="rounded-lg border border-border/60 bg-muted/20 p-3 flex items-center gap-3">
                <FileText className="h-4 w-4 text-muted-foreground/50" />
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium">{doc.title || doc.type}</span>
                  <span className="ml-2 text-[12px] text-muted-foreground">v{doc.version}</span>
                  {doc.retired_at && <span className="ml-2 text-[11px] text-muted-foreground/60">retired {new Date(doc.retired_at).toLocaleDateString()}</span>}
                </div>
                {doc.content_url && <a href={doc.content_url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-primary hover:underline">View</a>}
              </div>
            ))}
          </div>
        </div>
      )}
    </AccountPage>
  );
}