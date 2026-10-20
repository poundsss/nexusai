import React, { useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SKILL_CATEGORIES, SKILLS, RECOMMENDED_SKILLS, SKILL_COUNT } from "./skillCatalog";
import SkillCatalogRow from "./SkillCatalogRow";

// The full skills catalog ("Browse all"): search across every skill, filtered by category chips.
export default function BrowseAllSkillsDialog({ open, onOpenChange, activatedNames, busyKey, onActivate }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  const rows = useMemo(() => {
    const all = [...RECOMMENDED_SKILLS.map((s) => ({ key: s.key, description: s.description, updated: "Jun 16, 2026" })), ...SKILLS];
    return all.filter((s) => {
      if (category !== "all" && s.category !== category) return false;
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return s.key.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [query, category]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-[15px]">All skills</DialogTitle>
        </DialogHeader>
        <div className="relative mb-2">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${SKILL_COUNT} skills…`} className="h-8 pl-8 text-[12.5px]" />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          <button
            onClick={() => setCategory("all")}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${category === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >All</button>
          {SKILL_CATEGORIES.filter((c) => c.key !== "recommended").map((c) => (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${category === c.key ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            >{c.label}</button>
          ))}
        </div>
        <div className="overflow-y-auto scrollbar-thin -mx-1 px-1 pb-1">
          <div className="grid gap-3 sm:grid-cols-2">
            {rows.map((s) => (
              <SkillCatalogRow
                key={s.key}
                skill={s}
                activated={activatedNames.has(s.key)}
                busy={busyKey}
                onActivate={onActivate}
              />
            ))}
          </div>
          {rows.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground text-center py-8">No skills match “{query}”.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}