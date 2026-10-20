import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Sparkles, Plus, Trash2, Loader2, Pencil, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import RefineReviewDialog from "@/components/settings/RefineReviewDialog";

const EMPTY_FORM = { name: "", description: "", instructions: "" };

export default function SkillsTab({ workspace, user }) {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [source, setSource] = useState("scratch");
  const [presets, setPresets] = useState([]);
  const [refineBusy, setRefineBusy] = useState(false);
  const [review, setReview] = useState(null); // { original: {description, instructions}, refined }

  const load = async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("workspaceSkills", { action: "list", workspace_id: workspace.id });
      setSkills(res.data?.skills || []);
    } catch (e) {
      toast({ title: "Could not load skills", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [workspace?.id]);

  const loadPresets = async () => {
    setSource("presets");
    if (presets.length) return;
    try {
      const res = await base44.functions.invoke("workspaceSkills", { action: "presets", workspace_id: workspace.id });
      setPresets(res.data?.presets || []);
    } catch (e) {
      toast({ title: "Could not load presets", description: e.message, variant: "destructive" });
    }
  };

  // A preset only PREFILLS the existing editor; creation still goes through the normal CRUD.
  const applyPreset = (p) => {
    setForm({ name: p.name, description: p.description, instructions: p.instructions });
    setEditingId(null);
    setSource("scratch");
  };

  const save = async (values = form) => {
    setBusy(true);
    try {
      if (editingId) {
        await base44.functions.invoke("workspaceSkills", {
          action: "update", workspace_id: workspace.id, skill_id: editingId,
          patch: { name: values.name, description: values.description, instructions: values.instructions },
        });
        toast({ title: "Skill updated" });
      } else {
        await base44.functions.invoke("workspaceSkills", {
          action: "create", workspace_id: workspace.id,
          name: values.name, description: values.description, instructions: values.instructions,
        });
        toast({ title: "Skill added" });
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      await load();
    } catch (err) {
      toast({ title: editingId ? "Could not update skill" : "Could not add skill", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => { e.preventDefault(); save(); };

  const startEdit = (s) => {
    setForm({ name: s.name, description: s.description, instructions: s.instructions });
    setEditingId(s.id);
    setSource("scratch");
  };

  const toggle = async (skill) => {
    try {
      await base44.functions.invoke("workspaceSkills", { action: "update", workspace_id: workspace.id, skill_id: skill.id, patch: { enabled: !skill.enabled } });
      await load();
    } catch (err) {
      toast({ title: "Could not update skill", description: err.message, variant: "destructive" });
    }
  };

  const remove = async (skill) => {
    try {
      await base44.functions.invoke("workspaceSkills", { action: "delete", workspace_id: workspace.id, skill_id: skill.id });
      toast({ title: "Skill deleted" });
      if (editingId === skill.id) { setEditingId(null); setForm(EMPTY_FORM); }
      await load();
    } catch (err) {
      toast({ title: "Could not delete skill", description: err.message, variant: "destructive" });
    }
  };

  // Refine & review: ask the AI for a proposal of description + instructions, then let the
  // user compare, revert, save or cancel. Nothing is persisted until Save skill.
  const startRefine = async () => {
    setRefineBusy(true);
    const original = { description: form.description, instructions: form.instructions };
    try {
      const res = await base44.functions.invoke("workspaceSkills", {
        action: "refine", workspace_id: workspace.id, ...original,
      });
      const refined = res.data?.refined;
      if (!refined) throw new Error("No refinement was returned");
      setReview({ original, refined });
    } catch (err) {
      toast({ title: "Could not refine skill", description: err.message, variant: "destructive" });
    } finally {
      setRefineBusy(false);
    }
  };

  const backToOriginal = () => {
    if (review) setForm((f) => ({ ...f, ...review.original }));
    setReview(null);
  };

  const saveRefined = async () => {
    if (!review) return;
    const values = { ...form, description: review.refined.description, instructions: review.refined.instructions };
    setForm(values);
    setReview(null);
    await save(values);
  };

  const formReady = form.name.trim() && form.description.trim() && form.instructions.trim();

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-border p-5">
        <div className="flex items-start gap-3">
          <span className="h-10 w-10 rounded-lg grid place-items-center shrink-0 bg-brand-muted text-brand">
            <Sparkles className="h-5 w-5" />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">Workspace skills</h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Saved instruction sets that shape how the AI builds apps in this workspace. A disabled skill is ignored without deletion. Up to 100 skills per workspace.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border p-5">
        <h3 className="text-sm font-semibold mb-4">{editingId ? "Edit skill" : "Add a skill"}</h3>
        <div className="flex items-center gap-2 mb-4">
          <Button size="sm" variant={source === "scratch" ? "secondary" : "ghost"} onClick={() => setSource("scratch")}>Start from scratch</Button>
          <Button size="sm" variant={source === "presets" ? "secondary" : "ghost"} onClick={loadPresets}>Preset skill</Button>
        </div>
        {source === "presets" && (
          <div className="grid gap-2 sm:grid-cols-3 mb-4">
            {presets.length === 0 ? (
              <div className="text-[12px] text-muted-foreground py-2">Loading presets…</div>
            ) : presets.map((p) => (
              <div key={p.name} className="rounded-lg border border-border p-3 flex flex-col">
                <div className="text-[13px] font-medium">{p.name}</div>
                <p className="text-[12px] text-muted-foreground mt-1 flex-1">{p.description}</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => applyPreset(p)}>Add</Button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="skill-name">Name</Label>
              <Input id="skill-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="brand-guidelines" required maxLength={80} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-desc">Description — when it applies</Label>
              <Input id="skill-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Applies to marketing pages" required maxLength={500} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-instructions">Instructions</Label>
            <Textarea id="skill-instructions" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Step-by-step rules the AI should follow when this skill applies." rows={4} required maxLength={20000} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || !formReady} size="sm">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {editingId ? "Save skill" : "Add skill"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={startRefine} disabled={busy || refineBusy || !form.description.trim() || !form.instructions.trim()}>
              {refineBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Refine &amp; review
            </Button>
            {editingId && (
              <Button type="button" variant="ghost" size="sm" onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }}>Cancel edit</Button>
            )}
          </div>
        </form>
      </section>

      <section>
        <div className="flex items-center gap-1.5 mb-3">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Your skills ({skills.length}/100)</h3>
        </div>
        {loading ? (
          <div className="flex justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : skills.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-[13px] text-muted-foreground">No skills yet. Add one above to guide how the AI builds in this workspace.</div>
        ) : (
          <div className="space-y-2">
            {skills.map((s) => (
              <div key={s.id} className="flex items-start gap-3 rounded-lg border border-border px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium truncate">{s.name}</span>
                    <span className={`text-[11px] rounded px-1.5 py-0.5 ${s.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                      {s.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <p className="text-[12px] text-muted-foreground mt-0.5 truncate">{s.description}</p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => startEdit(s)} aria-label={`Edit ${s.name}`}>
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </Button>
                <Switch checked={s.enabled} onCheckedChange={() => toggle(s)} aria-label={`Toggle ${s.name}`} />
                <Button variant="ghost" size="icon" onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <RefineReviewDialog
        open={!!review}
        loading={refineBusy}
        original={review?.original}
        refined={review?.refined}
        onBackToOriginal={backToOriginal}
        onSave={saveRefined}
        onCancel={() => setReview(null)}
      />
    </div>
  );
}