import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Rocket, X } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Publishes one of the caller's projects into one of their TEMPLATE listings, through the
// certified `marketplace` `publish_project` action. The artifact is built, secret-scanned and
// checksummed SERVER-SIDE — the client supplies only project_id, listing_id, an optional
// version_number (defaults to the project's latest), a label, a changelog and an optional
// visibility flip. Only template listings are eligible (the backend rejects non-template with
// NOT_A_TEMPLATE). No approval/review state is invented — the returned version/status fields are
// shown verbatim.
export default function PublishVersionDialog({ wsId, listing, onClose, onDone }) {
  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = useState("");
  const [versionNumber, setVersionNumber] = useState("");
  const [label, setLabel] = useState("");
  const [changelog, setChangelog] = useState("");
  const [visibility, setVisibility] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const d = await workspaceRead("projects", { workspace_id: wsId, sort: "-updated_date", limit: 100 });
      const rows = d.projects || [];
      setProjects(rows);
      if (rows?.[0]?.id) setProjectId(rows[0].id);
    } catch (e) {
      setProjects([]);
      toast({ variant: "destructive", title: "Could not load projects", description: e.response?.data?.error || e.message });
    }
  }, [wsId]);

  useEffect(() => { load(); }, [load]);

  const publish = async () => {
    if (!projectId) { toast({ variant: "destructive", title: "Select a project" }); return; }
    setBusy(true); setResult(null);
    try {
      const res = await base44.functions.invoke("marketplace", {
        action: "publish_project", workspace_id: wsId,
        project_id: projectId, listing_id: listing.id,
        version_number: versionNumber.trim() ? Number(versionNumber) : null,
        version_label: label.trim() || null,
        changelog: changelog,
        visibility: visibility || null,
      });
      setResult(res.data);
      toast({ title: res.data?.duplicate ? "Version already published" : "Version published", description: `v${res.data?.version?.version_number} · ${res.data?.version?.status}` });
      if (onDone) await onDone();
    } catch (e) {
      toast({ variant: "destructive", title: "Publish failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  };

  const input = "h-8 rounded-md border border-border bg-background px-2 text-[12.5px] w-full";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-background shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Rocket className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold flex-1">Publish new version · {listing.name}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          <p className="text-[11.5px] text-muted-foreground">
            Publishes one of your projects into this template listing. The artifact is built and checksummed server-side. Only template listings are eligible.
          </p>
          <label className="block">
            <span className="text-[11px] text-muted-foreground">Project</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input}>
              {projects === null ? <option value="">Loading…</option> : projects.length === 0 ? <option value="">No projects</option> : projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Version number (optional, default latest)</span>
              <Input value={versionNumber} onChange={(e) => setVersionNumber(e.target.value.replace(/[^0-9]/g, ""))} placeholder="latest" className="h-8 text-[12.5px]" />
            </label>
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Version label</span>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="v1.0.0" className="h-8 text-[12.5px]" />
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] text-muted-foreground">Changelog</span>
            <textarea value={changelog} onChange={(e) => setChangelog(e.target.value)} rows={3} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px]" />
          </label>
          <label className="block">
            <span className="text-[11px] text-muted-foreground">Visibility (optional flip)</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className={input}>
              <option value="">No change</option>
              <option value="public">public</option>
              <option value="unlisted">unlisted</option>
              <option value="private">private</option>
            </select>
          </label>

          {result && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="font-medium">Published v{result.version?.version_number}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">{result.version?.status}</span>
                {result.duplicate && <span className="text-[10.5px] text-amber-600">duplicate</span>}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground font-mono">checksum {result.checksum?.slice(0, 24)}… · source v{result.source_version_number}</div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" onClick={publish} disabled={busy || !projectId}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}Publish version
          </Button>
        </div>
      </div>
    </div>
  );
}