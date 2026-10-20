import React from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Image } from "@/components/ui/image";
import { PROVIDER_META } from "./skillCatalog";
import SkillProviderIcon from "./SkillProviderIcon";

// One Recommended skill card: cover art, name + key, description, provider tags and the
// Activate skill action. `activated` (already in the workspace) swaps the button to a check.
export default function RecommendedSkillCard({ skill, activated, busy, onActivate }) {
  const isActivated = !!activated;
  return (
    <div className="flex flex-col rounded-lg border border-border overflow-hidden">
      <div className="aspect-[16/9] w-full overflow-hidden bg-muted">
        <Image src={skill.image} alt={skill.name} className="w-full h-full" fittingType="fill" />
      </div>
      <div className="p-3.5 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">{skill.name}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{skill.tagline}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0 pt-0.5">
            {(skill.providers || []).map((p) => <SkillProviderIcon key={p} tag={p} />)}
          </div>
        </div>
        <p className="text-[11.5px] text-muted-foreground leading-relaxed mt-2 flex-1">{skill.description}</p>
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            variant={isActivated ? "secondary" : "default"}
            disabled={isActivated || busy === skill.key}
            onClick={() => onActivate(skill)}
            className="h-7 px-3 text-[11.5px]"
          >
            {busy === skill.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : isActivated ? <><Check className="h-3.5 w-3.5" />Activated</>
              : "Activate skill"}
          </Button>
        </div>
      </div>
    </div>
  );
}