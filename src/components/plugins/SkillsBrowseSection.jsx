import React, { useState } from "react";
import { SKILL_CATEGORIES, SKILLS, RECOMMENDED_SKILLS, SKILL_COUNT } from "./skillCatalog";
import SkillCatalogRow from "./SkillCatalogRow";
import BrowseAllSkillsDialog from "./BrowseAllSkillsDialog";

// "Browse by what you want to do" — the category chips and the two-column catalog grid,
// with the full-catalog dialog behind "Browse all →".
export default function SkillsBrowseSection({ activatedNames, busyKey, onActivate }) {
  const [category, setCategory] = useState("recommended");
  const [browseOpen, setBrowseOpen] = useState(false);
  const browseCategories = SKILL_CATEGORIES.filter((c) => c.key !== "recommended");

  const rowsFor = (key) => (key === "recommended"
    ? RECOMMENDED_SKILLS.map((s) => ({ key: s.key, description: s.description, updated: "Jun 16, 2026" }))
    : SKILLS.filter((s) => s.category === key));

  return (
    <div className="mt-8">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-[13.5px] font-semibold">Browse by what you want to do</h3>
        <button onClick={() => setBrowseOpen(true)} className="text-[12px] font-medium text-brand hover:underline underline-offset-2">
          Browse all →
        </button>
      </div>
      <p className="text-[11.5px] text-muted-foreground mb-3">{SKILL_COUNT} skills across every kind of work.</p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {browseCategories.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${category === c.key ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {rowsFor(category).map((s) => (
          <SkillCatalogRow
            key={s.key}
            skill={s}
            activated={activatedNames.has(s.key)}
            busy={busyKey}
            onActivate={onActivate}
          />
        ))}
      </div>

      <BrowseAllSkillsDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        activatedNames={activatedNames}
        busyKey={busyKey}
        onActivate={onActivate}
      />
    </div>
  );
}