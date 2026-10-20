import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Puzzle, Power, Trash2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import RecommendedSkillCard from "./RecommendedSkillCard";
import { RECOMMENDED_SKILLS } from "./skillCatalog";
import SkillsBrowseSection from "./SkillsBrowseSection";

// The Skills tab, modeled 1:1 on Base44's Superagent skills gallery: three Recommended skill
// cards with cover art, the "Browse by what you want to do" catalog, and the full-catalog
// dialog. Activation creates a REAL workspace skill through the existing certified
// workspaceSkills contract (create/list/update/delete) — the catalog's instruction block is
// what the agent follows at runtime, and the "Your skills" section manages what was activated.
export default function SkillsTab({ workspace }) {
  const [skills, setSkills] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await base44.functions.invoke("workspaceSkills", { action: "list", workspace_id: workspace.id });
      setSkills(res.data?.skills || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setSkills([]);
    }
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  const activatedNames = useMemo(() => new Set((skills || []).map((s) => s.name)), [skills]);

  const activate = async (skill) => {
    setBusyKey(skill.key);
    try {
      await base44.functions.invoke("workspaceSkills", {
        action: "create", workspace_id: workspace.id,
        name: skill.key, description: skill.description, instructions: skill.instructions,
      });
      toast({ title: `Skill "${skill.name}" activated` });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not activate skill", description: e.response?.data?.error || e.message });
    } finally { setBusyKey(null); }
  };

  const toggle = async (s) => {
    setBusyKey(s.name);
    try {
      await base44.functions.invoke("workspaceSkills", {
        action: "update", workspace_id: workspace.id, skill_id: s.skill_id || s.id,
        patch: { enabled: s.enabled === false },
      });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not update skill", description: e.response?.data?.error || e.message });
    } finally { setBusyKey(null); }
  };

  const remove = async (s) => {
    setBusyKey(s.name);
    try {
      await base44.functions.invoke("workspaceSkills", {
        action: "delete", workspace_id: workspace.id, skill_id: s.skill_id || s.id,
      });
      toast({ title: "Skill removed" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not remove skill", description: e.response?.data?.error || e.message });
    } finally { setBusyKey(null); }
  };

  if (skills === null) {
    return <div className="py-8 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  }

  return (
    <div>
      {error && <p className="text-[12px] text-destructive mb-3">{error}</p>}

      {/* Recommended skills */}
      <h3 className="text-[13.5px] font-semibold mb-3">Recommended skills</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        {RECOMMENDED_SKILLS.map((s) => (
          <RecommendedSkillCard
            key={s.key}
            skill={s}
            activated={activatedNames.has(s.key)}
            busy={busyKey}
            onActivate={activate}
          />
        ))}
      </div>

      <SkillsBrowseSection activatedNames={activatedNames} busyKey={busyKey} onActivate={activate} />

      {/* Your skills — everything activated into this workspace. */}
      <div className="mt-8">
        <h3 className="text-[13.5px] font-semibold mb-3">Your skills ({(skills || []).length}/100)</h3>
        {skills.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground/60 py-4 text-center rounded-md border border-border border-dashed">
            No skills activated yet — activate one above.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {skills.map((s) => {
              const id = s.skill_id || s.id;
              return (
                <li key={id} className="px-3 py-2 flex items-center gap-3">
                  <Puzzle className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-[12.5px] font-medium truncate flex-1">/{s.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${s.enabled !== false ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                    {s.enabled !== false ? "enabled" : "disabled"}
                  </span>
                  <button onClick={() => toggle(s)} disabled={busyKey === s.name} title={s.enabled !== false ? "Disable" : "Enable"} className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                    {busyKey === s.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                  </button>
                  <button onClick={() => remove(s)} disabled={busyKey === s.name} title="Remove" className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}