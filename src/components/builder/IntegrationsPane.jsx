import React, { useEffect, useMemo, useState } from "react";
import { Plug, Plus, Loader2, AlertCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useIntegrations } from "@/hooks/useIntegrations";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import IntegrationCard from "./IntegrationCard";
import IntegrationFormDialog from "./IntegrationFormDialog";
import IntegrationTestDialog from "./IntegrationTestDialog";

const CALL_RE = /\bintegrations\s*\.\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;

// Builder Integrations pane. The authorized Integration API (#31E) is the authoritative
// management surface: list/create/update/disable/test_call all go through it. The pane only
// adds read-only usage analysis (which functions call which integration) from the project's
// file list, and a secret set/unset indicator from projectSecrets — neither of which is a
// management path. Secret VALUES are never requested and never rendered.
export default function IntegrationsPane({ projectId, files, onOpenFile }) {
  const { integrations, loading, error, create, update, disable, testCall } = useIntegrations(projectId);
  const [secrets, setSecrets] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState("create");
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);

  useEffect(() => {
    if (!projectId) return;
    base44.functions.invoke("projectSecrets", { project_id: projectId, action: "list" })
      .then((r) => setSecrets(r.data.secrets || [])).catch(() => {});
  }, [projectId, integrations.length]);

  const usedBy = useMemo(() => {
    const map = {};
    for (const f of (files || []).filter((x) => x.path.startsWith("functions/"))) {
      for (const m of (f.content || "").matchAll(CALL_RE)) (map[m[1]] ||= new Set()).add(f.path.slice("functions/".length, -3));
    }
    return map;
  }, [files]);

  const setNames = new Set(secrets.filter((s) => s.is_set).map((s) => s.name));

  const openCreate = () => { setFormMode("create"); setEditing(null); setFormOpen(true); };
  const openEdit = (i) => { setFormMode("update"); setEditing(i); setFormOpen(true); };
  const submitForm = async (def) => {
    if (formMode === "create") await create(def);
    else await update(def);
  };
  const doDisable = async (i) => {
    try { await disable(i.name); toast({ title: `Disabled ${i.name}` }); }
    catch (e) { toast({ variant: "destructive", title: "Failed", description: e.response?.data?.error || e.message }); }
  };
  const doEnable = async (i) => {
    // Re-enable by updating the definition with status active (the normalizer defaults to active
    // unless status is explicitly "disabled"). Runtime-only fields are stripped by the dialog.
    try { await update({ ...i, status: "active" }); toast({ title: `Enabled ${i.name}` }); }
    catch (e) { toast({ variant: "destructive", title: "Failed", description: e.response?.data?.error || e.message }); }
  };

  return (
    <div className="h-full overflow-auto p-5 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Plug className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold tracking-tight">Integrations</h2>
        <Button size="sm" variant="outline" className="ml-auto h-7 gap-1" onClick={openCreate}><Plus className="h-3.5 w-3.5" />New</Button>
      </div>
      <p className="text-muted-foreground mb-4">External APIs this app can call from its backend functions. Each integration is a versioned project artifact; its credential is a reference to a secret, never a stored value.</p>
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div><div className="font-medium">Failed to load integrations</div><div className="text-[12px]">{error}</div></div>
        </div>
      ) : integrations.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-muted-foreground/60">No integrations yet. Ask the AI to connect an external API, or click <span className="font-medium text-muted-foreground">New</span> to declare one.</div>
      ) : (
        <div className="space-y-3">
          {integrations.map((i) => (
            <IntegrationCard
              key={i.path || i.name}
              integration={i}
              secretSet={!!i.auth?.secret && setNames.has(i.auth.secret)}
              usedBy={[...(usedBy[i.name] || [])]}
              onOpenFile={onOpenFile}
              onTest={() => setTesting(i)}
              onEdit={() => openEdit(i)}
              onDisable={() => doDisable(i)}
              onEnable={() => doEnable(i)}
            />
          ))}
        </div>
      )}
      <IntegrationFormDialog open={formOpen} mode={formMode} integration={editing} onClose={() => setFormOpen(false)} onSubmit={submitForm} />
      <IntegrationTestDialog open={!!testing} integration={testing} onClose={() => setTesting(null)} onTest={testCall} />
    </div>
  );
}