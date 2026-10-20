import React from "react";
import { useActorPresence } from "@/hooks/useActorPresence";

// Named collaborator presence on the Builder canvas. Renders the existing actor room's connected
// participants (minus the current user) as avatars. Only the certified presence data (participant
// identity, resolved to a name through workspaceMembers) is shown — no cursor positions or
// element selections are invented (the actor contract carries none).
export default function CollaboratorPresence({ projectId }) {
  const participants = useActorPresence(projectId);
  if (!participants.length) return null;
  const shown = participants.slice(0, 5);
  const extra = participants.length - shown.length;
  const colorFor = (id) => {
    const palette = ["bg-brand", "bg-emerald-600", "bg-amber-600", "bg-rose-600", "bg-sky-600", "bg-violet-600"];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
    return palette[h % palette.length];
  };
  return (
    <div className="absolute top-2 right-2 z-20 flex items-center -space-x-1.5" aria-label="Collaborators present">
      {shown.map((p) => (
        <span
          key={p.id}
          title={p.name ? `${p.name} is viewing` : "A collaborator is viewing"}
          className={`h-6 w-6 rounded-full ${colorFor(p.id)} text-white ring-2 ring-background grid place-items-center text-[10px] font-semibold`}
        >
          {(p.name || p.id || "?").slice(0, 1).toUpperCase()}
        </span>
      ))}
      {extra > 0 && (
        <span className="h-6 w-6 rounded-full bg-muted text-muted-foreground ring-2 ring-background grid place-items-center text-[9.5px] font-semibold">
          +{extra}
        </span>
      )}
    </div>
  );
}