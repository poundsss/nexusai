import React from "react";
import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export default function GrowModelMenu({ models, value, onChange, selectionAllowed }) {
  const selected = models.find((model) => model.model_id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select Grow model" className="flex h-8 min-w-0 items-center justify-between gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 text-[12.5px] text-muted-foreground">
          <span className="max-w-28 truncate">{selected?.display_name || "Auto"}</span><ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="flex-1">Auto</span>{!value && <Check className="h-4 w-4" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {!models.length && <p className="px-2 py-2 text-xs text-muted-foreground">Automatic model selection is available.</p>}
        {models.map((model) => (
          <DropdownMenuItem key={model.model_id} disabled={!selectionAllowed} onSelect={() => onChange(model.model_id)}>
            <div className="min-w-0 flex-1">
              <p className="truncate">{model.display_name}</p>
              {["premium", "flagship", "advanced"].includes(model.quality_tier?.toLowerCase()) && <p className="text-xs text-muted-foreground">Uses more credits</p>}
            </div>
            {value === model.model_id && <Check className="h-4 w-4" />}
          </DropdownMenuItem>
        ))}
        {!selectionAllowed && <p className="px-2 py-2 text-xs text-muted-foreground">Manual selection is unavailable for this workspace.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}