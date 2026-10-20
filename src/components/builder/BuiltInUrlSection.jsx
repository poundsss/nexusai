import React, { useEffect, useState } from "react";
import { Edit3, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { toast } from "@/components/ui/use-toast";

// Built-in URL section for the Domains pane (Base44: Domains → Built-in URL → Edit URL).
// Shows the project's current *.base44.app address and lets an owner/admin/editor change the
// slug through the existing projectDomains `change_slug` action (project.write auth, existing
// validateSlug contract, platform-wide uniqueness). Only Project.slug moves — deployments,
// custom domains, versions, visibility and lifecycle are untouched. The old URL stops
// resolving immediately; the new URL serves the same LIVE deployment without redeploying.
export default function BuiltInUrlSection({ projectId, onChanged }) {
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (!projectId) { setLoading(false); return; }
    const p = (await workspaceRead("project", { project_id: projectId })).project;
    setSlug(p?.slug || "");
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((e) => toast({ variant: "destructive", title: "Could not load URL", description: e.response?.data?.error || e.message }))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const startEdit = () => { setDraft(slug); setError(""); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setError(""); setDraft(""); };

  const save = async () => {
    if (saving) return;
    const next = draft.trim().toLowerCase();
    if (!next) { setError("A URL is required"); return; }
    if (next === slug) { setEditing(false); return; }
    setSaving(true); setError("");
    try {
      const res = await base44.functions.invoke("projectDomains", { action: "change_slug", project_id: projectId, slug: next });
      setSlug(res?.data?.slug || next);
      setEditing(false); setDraft("");
      onChanged?.();
      toast({ title: "Built-in URL changed", description: `${next}.base44.app` });
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Could not change the URL");
    } finally { setSaving(false); }
  };

  if (!projectId) return null;

  return (
    <div className="mb-5 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-medium text-muted-foreground">Built-in URL</h3>
        {!loading && slug && !editing && (
          <button
            onClick={startEdit}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors"
          >
            <Edit3 className="h-3 w-3" />Edit URL
          </button>
        )}
      </div>

      {loading ? (
        <div className="mt-2 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      ) : editing ? (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancelEdit(); }}
              placeholder="my-app"
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="shrink-0 font-mono text-[12px] text-muted-foreground">.base44.app</span>
          </div>
          <p className="text-[10.5px] text-muted-foreground/70">Lowercase letters, numbers and hyphens (2–60 chars). The old link stops working immediately.</p>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving || !draft.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}Change
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1">
          <span className="font-mono text-[13px] break-all">{slug || "—"}</span>
          <span className="font-mono text-[13px] text-muted-foreground">.base44.app</span>
        </div>
      )}
    </div>
  );
}