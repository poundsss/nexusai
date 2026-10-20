import React from "react";
import { RefreshCw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { LOG_EVENT_TYPES } from "@/hooks/useLogs";

export default function LogsToolbar({ projects, projectId, onProjectChange, eventType, onEventTypeChange, errorsOnly, onErrorsOnlyChange, onRefresh, loading }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Select value={projectId} onValueChange={onProjectChange}>
        <SelectTrigger className="h-8 w-[190px] text-[12px]"><SelectValue placeholder="Select app" /></SelectTrigger>
        <SelectContent>
          {projects.map((p) => <SelectItem key={p.id} value={p.id} className="text-[12px]">{p.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={eventType || "all"} onValueChange={(v) => onEventTypeChange(v === "all" ? "" : v)}>
        <SelectTrigger className="h-8 w-[190px] text-[12px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          {LOG_EVENT_TYPES.map((t) => <SelectItem key={t.value || "all"} value={t.value || "all"} className="text-[12px]">{t.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground select-none">
        <Switch checked={errorsOnly} onCheckedChange={onErrorsOnlyChange} />
        Errors only
      </label>
      <Button variant="outline" size="icon" onClick={onRefresh} title="Refresh" disabled={loading}>
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}