import React from "react";
import {
  MessageSquare, Gauge, FileBarChart, SlidersHorizontal,
  Send, LifeBuoy, Building2, CalendarDays,
} from "lucide-react";

// The Grow view switcher — the single navigation entry point between the chat-first surface
// and the six read-only management panels plus the publishing calendar. Chat stays the default
// view; every other view returns to it through the same tab, so navigation never needs a query
// parameter (the preserved ?tiktok return flow keeps opening the calendar dialog in place).
const VIEWS = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "report", label: "Report", icon: FileBarChart },
  { id: "optimize", label: "Optimize", icon: SlidersHorizontal },
  { id: "outreach", label: "Outreach", icon: Send },
  { id: "support", label: "Support", icon: LifeBuoy },
  { id: "company", label: "Company", icon: Building2 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
];

export default function GrowViewSwitcher({ view, onChange }) {
  return (
    <div className="shrink-0 border-b border-border px-3 py-2 sm:px-6" role="tablist" aria-label="Grow views">
      <div className="mx-auto flex max-w-5xl items-center gap-1.5 overflow-x-auto no-scrollbar">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => onChange(id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
              view === id
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}