import React from "react";
import { Button } from "@/components/ui/button";

export default function MemberRow({ member, canManage, onRemove }) {
  const initial = (member.full_name || member.email || "?").charAt(0).toUpperCase();
  const isYou = member.is_you;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <span className="h-9 w-9 shrink-0 rounded-full bg-muted text-muted-foreground grid place-items-center text-[13px] font-semibold uppercase">
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium truncate">{member.full_name || member.email}</span>
          {isYou && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">You</span>}
        </div>
        <div className="text-[11.5px] text-muted-foreground truncate">{member.email}</div>
      </div>
      <span className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${member.role === "admin" ? "bg-amber-500/10 text-amber-600" : "bg-muted text-muted-foreground"}`}>
        {member.role}
      </span>
      {canManage && !isYou && (
        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => onRemove(member)} title="Remove member">
          Remove
        </Button>
      )}
    </div>
  );
}