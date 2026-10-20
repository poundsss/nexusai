import React, { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import AgentChannelsCard from "./AgentChannelsCard";

const L = "text-[11px] font-medium text-muted-foreground";
const F = "text-[12px]";
const SECTION = "text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/70 mt-3 mb-1.5";

const splitList = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const nameFromPath = (p) => String(p || "").replace("base44/agents/", "").replace(/\.jsonc$/, "");

function parseToolGrants(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const m = l.match(/^([A-Za-z][A-Za-z0-9_]{0,63})\s*:\s*(.+)$/);
    if (m) out.push({ entity_name: m[1], allowed_operations: m[2].split(",").map((s) => s.trim()).filter(Boolean) });
    else {
      const fn = l.match(/^([a-zA-Z][a-zA-Z0-9_]*)/);
      if (fn) out.push({ function_name: fn[1] });
    }
  }
  return out;
}

function formFromDoc(doc) {
  return {
    name: doc?.name || "",
    display_name: doc?.display_name && doc.display_name !== doc.name ? doc.display_name : "",
    description: doc?.description || "",
    instructions: doc?.instructions || "",
    tools: (doc?.tools || []).join(", "),
    tool_entities: (doc?.tool_configs || []).map((tc) => tc.entity_name ? `${tc.entity_name}: ${(tc.allowed_operations || []).join(", ")}` : tc.function_name).join("\n"),
    skills: (doc?.skills || []).join(", "),
    selected_skill_names: (doc?.selected_skill_names || []).join(", "),
    connectors: (doc?.connectors || []).join(", "),
    model: doc?.model || "",
    model_tier: doc?.model_tier || "",
    max_steps: doc?.max_steps ?? "",
    automations_model: doc?.automations_model || "",
    telegram_greeting: doc?.telegram_greeting || "",
    whatsapp_greeting: doc?.whatsapp_greeting || "",
    context_files: (doc?.context_files || []).join(", "),
    memory_enabled: doc?.memory_config ? doc.memory_config.enabled !== false : true,
    memory_scope: doc?.memory_config?.scope || "both",
    memory_instructions: doc?.memory_config?.instructions || "",
    anonymous: doc?.allow_anonymous_access === true,
    cross_apps: (doc?.cross_app_access || []).slice(0, 25),
  };
}

export default function AgentEditorDialog({ projectId, projectSlug, onOpenSecrets, files, file, version, onClose, onSaved }) {
  const editing = !!file;
  const [form, setForm] = useState(() => {
    if (!file) return formFromDoc(null);
    try { return formFromDoc(JSON.parse((files || []).find((f) => f.path === file)?.content || "{}")); }
    catch { return formFromDoc(null); }
  });
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState([]);
  const [crossApps, setCrossApps] = useState(null);
  const [models, setModels] = useState([]);
  useEffect(() => {
    let alive = true;
    workspaceRead("project", { project_id: projectId })
      .then(async (d) => {
        const p = d.project;
        const rows = p?.workspace_id
          ? await workspaceRead("projects", { workspace_id: p.workspace_id, sort: "name", limit: 100 }).then((r) => r.projects).catch(() => [])
          : [];
        return { p, rows };
      })
      .then(({ p, rows }) => {
        if (!alive) return;
        setCrossApps((rows || []).filter((r) => r.id !== projectId).map((r) => ({ id: r.id, name: r.name })));
        if (p?.workspace_id) {
          base44.functions.invoke("commerce", { action: "models", workspace_id: p.workspace_id })
            .then((res) => { if (alive) setModels(res?.data?.models || []); })
            .catch(() => {});
        }
      })
      .catch(() => { if (alive) setCrossApps([]); });
    return () => { alive = false; };
  }, [projectId]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target?.type === "checkbox" ? e.target.checked : e.target.value }));
  const switchSet = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const payload = () => ({
    name: form.name.trim(),
    display_name: form.display_name.trim() || null,
    description: form.description.trim() || null,
    instructions: form.instructions,
    tools: splitList(form.tools),
    tool_configs: parseToolGrants(form.tool_entities),
    skills: splitList(form.skills),
    selected_skill_names: splitList(form.selected_skill_names),
    connectors: splitList(form.connectors),
    model: form.model.trim() || null,
    model_tier: form.model_tier || null,
    max_steps: form.max_steps === "" ? null : Number(form.max_steps),
    automations_model: form.automations_model.trim() || null,
    telegram_greeting: form.telegram_greeting.trim() || null,
    whatsapp_greeting: form.whatsapp_greeting.trim() || null,
    context_files: splitList(form.context_files),
    memory_config: { enabled: form.memory_enabled, scope: form.memory_scope, instructions: form.memory_instructions.trim() || null },
    allow_anonymous_access: form.anonymous,
    cross_app_access: form.cross_apps,
  });

  const call = async (action) => {
    setBusy(action);
    setErrors([]);
    try {
      const res = await base44.functions.invoke("agentEditor", {
        action, project_id: projectId,
        original_name: editing ? nameFromPath(file) : null,
        expected_version: typeof version === "number" ? version : null,
        agent: payload(),
      });
      const d = res?.data || res;
      if (action === "validate") toast({ title: "Configuration is valid", description: `${d.agent_name || form.name} · ${d.path}` });
      else {
        toast({ title: d.unchanged ? "No change" : `Saved as version ${d.version?.number ?? ""}`, description: `Agent "${payload().name}" ${editing ? "updated" : "created"}` });
        if (!d.unchanged) { onClose(); if (onSaved) await onSaved(); }
      }
    } catch (e) {
      const d = e.response?.data;
      setErrors(d?.details?.errors?.length ? d.details.errors : [d?.error || e.message]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{editing ? "Edit agent" : "New agent"}</DialogTitle>
        </DialogHeader>
        <p className="text-[11.5px] text-muted-foreground">
          Configuration of <span className="font-mono">base44/agents/&lt;name&gt;.jsonc</span>. Saving commits a new project version; the server validates every field and reference.
        </p>

        <div className={SECTION}>Identity</div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label className={L}>Name (file identity)</Label><Input className={`${F} mt-1`} value={form.name} onChange={set("name")} disabled={editing} placeholder="support-desk" /></div>
          <div><Label className={L}>Display name</Label><Input className={`${F} mt-1`} value={form.display_name} onChange={set("display_name")} /></div>
        </div>
        <div className="mt-2"><Label className={L}>Description</Label><Input className={`${F} mt-1`} value={form.description} onChange={set("description")} /></div>

        <div className={SECTION}>Behaviour</div>
        <Textarea className={`${F} min-h-[64px]`} rows={3} value={form.instructions} onChange={set("instructions")} placeholder="What the agent does — required" />

        <div className={SECTION}>Tools &amp; skills</div>
        <div><Label className={L}>Tools (comma-separated)</Label><Input className={`${F} mt-1`} value={form.tools} onChange={set("tools")} placeholder="read_file, list_files" /></div>
        <div className="mt-2">
          <Label className={L}>Tool grants — one per line: Entity: operations, or a function name</Label>
          <Textarea className={`${F} mt-1 min-h-[48px]`} rows={2} value={form.tool_entities} onChange={set("tool_entities")} placeholder={"Task: create, read\ngetWeather"} />
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div><Label className={L}>Builder skills</Label><Input className={`${F} mt-1`} value={form.skills} onChange={set("skills")} /></div>
          <div><Label className={L}>In-app skills (max 10)</Label><Input className={`${F} mt-1`} value={form.selected_skill_names} onChange={set("selected_skill_names")} /></div>
        </div>
        <div className="mt-2"><Label className={L}>Connectors (lowerCamelCase)</Label><Input className={`${F} mt-1`} value={form.connectors} onChange={set("connectors")} placeholder="googleCalendar" /></div>

        <div className={SECTION}>Model</div>
        <div className="grid grid-cols-3 gap-2">
          <div><Label className={L}>Model pin</Label><Input className={`${F} mt-1`} value={form.model} onChange={set("model")} placeholder="automatic" /></div>
          <div><Label className={L}>Tier</Label>
            <select className={`${F} mt-1 h-8 w-full rounded-md border border-input bg-background px-2`} value={form.model_tier} onChange={set("model_tier")}>
              <option value="">automatic</option><option value="fast">fast</option><option value="standard">standard</option><option value="advanced">advanced</option>
            </select>
          </div>
          <div><Label className={L}>Max steps</Label><Input className={`${F} mt-1`} type="number" min="1" value={form.max_steps} onChange={set("max_steps")} /></div>
        </div>
        <div className="mt-2">
          <Label className={L}>Automations model</Label>
          <select className={`${F} mt-1 h-8 w-full rounded-md border border-input bg-background px-2`} value={form.automations_model} onChange={set("automations_model")}>
            <option value="">automatic (same as General)</option>
            {models.map((m) => <option key={m.model_id} value={m.model_id}>{m.display_name} · {m.quality_tier}</option>)}
          </select>
          <p className="text-[10.5px] text-muted-foreground/70 mt-1">Applies to schedule-triggered runs of this agent; chat runs keep the General model.</p>
        </div>

        <div className={SECTION}>Memory</div>
        <div className="flex items-center gap-3">
          <Switch checked={form.memory_enabled} onCheckedChange={switchSet("memory_enabled")} />
          <span className={`${F} text-muted-foreground`}>Memory {form.memory_enabled ? "on" : "off"}</span>
          <select className={`${F} ml-auto h-8 rounded-md border border-input bg-background px-2`} value={form.memory_scope} onChange={set("memory_scope")}>
            <option value="global">global</option><option value="user">user</option><option value="both">both</option>
          </select>
        </div>
        <Input className={`${F} mt-2`} value={form.memory_instructions} onChange={set("memory_instructions")} placeholder="Memory instructions (optional)" />

        <div className={SECTION}>Access &amp; channels</div>
        <div className="flex items-center gap-3"><Switch checked={form.anonymous} onCheckedChange={switchSet("anonymous")} /><span className={F}>Allow anonymous access</span></div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div><Label className={L}>Telegram greeting</Label><Input className={`${F} mt-1`} value={form.telegram_greeting} onChange={set("telegram_greeting")} /></div>
          <div><Label className={L}>WhatsApp greeting</Label><Input className={`${F} mt-1`} value={form.whatsapp_greeting} onChange={set("whatsapp_greeting")} /></div>
        </div>
        <div className="mt-2"><Label className={L}>Context files (comma-separated base44/context/ paths)</Label><Input className={`${F} mt-1`} value={form.context_files} onChange={set("context_files")} placeholder="base44/context/faq.md" /></div>

        <div className={SECTION}>Cross-app data access</div>
        {crossApps === null ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : crossApps.length === 0 ? (
          <p className={`${F} text-muted-foreground/60`}>No other app in this workspace to grant.</p>
        ) : (
          <div className="space-y-1">
            {crossApps.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={form.cross_apps.includes(a.id)} onChange={() => setForm((f) => ({ ...f, cross_apps: f.cross_apps.includes(a.id) ? f.cross_apps.filter((x) => x !== a.id) : [...f.cross_apps, a.id] }))} />
                {a.name}
              </label>
            ))}
          </div>
        )}
        <p className="mt-1 text-[10.5px] text-muted-foreground/70">Interactive actions run as the chatting user under their own permissions; background watches run as the owner.</p>

        <AgentChannelsCard projectId={projectId} projectSlug={projectSlug} agentName={form.name} onOpenSecrets={onOpenSecrets} />

        {errors.length > 0 && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
            {errors.map((er, i) => <p key={i} className="text-[11.5px] text-destructive">{er}</p>)}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => call("validate")}>
            {busy === "validate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Validate
          </Button>
          <Button size="sm" disabled={busy !== null || !form.name.trim() || !form.instructions.trim()} onClick={() => call("save")}>
            {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{editing ? "Save changes" : "Create agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}