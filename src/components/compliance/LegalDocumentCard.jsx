import React from "react";
import { FileText, CheckCircle2, Clock, History, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const TYPE_LABELS = {
  tos: "Terms of Service",
  privacy_policy: "Privacy Policy",
  dpa: "Data Processing Agreement",
  acceptable_use: "Acceptable Use Policy",
  subprocessor_list: "Subprocessor List",
  cookie_policy: "Cookie Policy",
};

const STATUS_STYLES = {
  active: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  draft: "bg-muted text-muted-foreground border-border",
  retired: "bg-muted/50 text-muted-foreground/60 border-border",
};

export default function LegalDocumentCard({ doc, accepted, onAccept, working, canManage, onRetire }) {
  const isAccepted = accepted;
  const isActive = doc.status === "active";

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className={`h-9 w-9 rounded-lg grid place-items-center shrink-0 ${isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
          <FileText className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-[14px]">{doc.title || TYPE_LABELS[doc.type] || doc.type}</h3>
            <Badge variant="outline" className={`text-[10px] font-medium ${STATUS_STYLES[doc.status] || ""}`}>{doc.status}</Badge>
            {isAccepted && isActive && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 font-medium">
                <CheckCircle2 className="h-3 w-3" />Accepted
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[12px] text-muted-foreground">
            <span className="font-mono">{doc.type}</span>
            <span>v{doc.version}</span>
            {doc.effective_date && <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(doc.effective_date).toLocaleDateString()}</span>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {doc.content_url && (
          <a href={doc.content_url} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm"><ExternalLink className="h-3.5 w-3.5 mr-1.5" />Read document</Button>
          </a>
        )}
        {isActive && !isAccepted && onAccept && (
          <Button size="sm" onClick={() => onAccept(doc.id)} disabled={working}>
            {working ? "Accepting…" : "Accept"}
          </Button>
        )}
        {isActive && isAccepted && (
          <span className="text-[12px] text-muted-foreground">You accepted this version</span>
        )}
        {canManage && isActive && onRetire && (
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => onRetire(doc.id)} disabled={working}>
            <History className="h-3.5 w-3.5 mr-1.5" />Retire
          </Button>
        )}
      </div>
    </div>
  );
}