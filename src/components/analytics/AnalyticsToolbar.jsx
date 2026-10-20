import React from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw } from "lucide-react";
import { RANGE_OPTIONS } from "@/hooks/useAppAnalytics";

// Application + bounded time range selection. The range presets are the only windows the UI asks
// for; the server clamps anything wider.
export default function AnalyticsToolbar({ projects, projectId, onProjectChange, days, onDaysChange, onRefresh }) {
  return (
    <div className="flex items-center gap-2">
      <Select value={projectId} onValueChange={onProjectChange}>
        <SelectTrigger className="h-8 w-[200px] text-[13px]"><SelectValue placeholder="Select an application" /></SelectTrigger>
        <SelectContent>
          {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={String(days)} onValueChange={(v) => onDaysChange(Number(v))}>
        <SelectTrigger className="h-8 w-[130px] text-[13px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          {RANGE_OPTIONS.map((r) => <SelectItem key={r.days} value={String(r.days)}>Last {r.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh</Button>
    </div>
  );
}