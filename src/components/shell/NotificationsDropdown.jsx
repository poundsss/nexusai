import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { Bell, CheckCircle2, AlertCircle, Info, GitBranch, Rocket, Hammer, Users, CheckCheck, Coins, Pause, Play, Zap, CalendarClock, CalendarCheck, Archive, ArchiveRestore } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const ICONS = {
  "project.created": CheckCircle2,
  "project.deployed": Rocket,
  "build.completed": Hammer,
  "build.failed": AlertCircle,
  "git.exported": GitBranch,
  "git.imported": GitBranch,
  "member.invited": Users,
  "billing.purchase": Coins,
  "billing.adjustment": Coins,
  "billing.subscription.started": Coins,
  "billing.subscription.cancelled": Coins,
  "schedule.paused": AlertCircle,
  "schedule.ended": CheckCircle2,
  // Scheduled Superagent Workflows (agent_schedule.*) — dedicated icon/tone per action.
  "agent_schedule.paused": Pause,
  "agent_schedule.ended": CalendarCheck,
  "agent_schedule.fired": Zap,
  "agent_schedule.run_now": Zap,
  "agent_schedule.resumed": Play,
  "agent_schedule.created": CalendarClock,
  "agent_schedule.updated": CalendarClock,
  "agent_schedule.archived": Archive,
  "agent_schedule.restored": ArchiveRestore,
};

// Human labels for the agent_schedule.* events; everything else keeps the generic prettifier.
const LABELS = {
  "agent_schedule.paused": "Scheduled workflow paused",
  "agent_schedule.ended": "Scheduled workflow ended",
  "agent_schedule.fired": "Scheduled workflow ran",
  "agent_schedule.run_now": "Scheduled workflow run now",
  "agent_schedule.resumed": "Scheduled workflow resumed",
  "agent_schedule.created": "Scheduled workflow created",
  "agent_schedule.updated": "Scheduled workflow updated",
  "agent_schedule.archived": "Scheduled workflow archived",
  "agent_schedule.restored": "Scheduled workflow restored",
};

const TONES = {
  "project.created": "text-emerald-600",
  "project.deployed": "text-blue-600",
  "build.completed": "text-emerald-600",
  "build.failed": "text-destructive",
  "git.exported": "text-muted-foreground",
  "git.imported": "text-muted-foreground",
  "member.invited": "text-muted-foreground",
  "billing.purchase": "text-amber-600",
  "billing.adjustment": "text-amber-600",
  "billing.subscription.started": "text-amber-600",
  "billing.subscription.cancelled": "text-muted-foreground",
  "schedule.paused": "text-amber-600",
  "schedule.ended": "text-emerald-600",
  "agent_schedule.paused": "text-amber-600",
  "agent_schedule.ended": "text-emerald-600",
  "agent_schedule.fired": "text-emerald-600",
  "agent_schedule.run_now": "text-blue-600",
  "agent_schedule.resumed": "text-emerald-600",
  "agent_schedule.created": "text-muted-foreground",
  "agent_schedule.updated": "text-muted-foreground",
  "agent_schedule.archived": "text-muted-foreground",
  "agent_schedule.restored": "text-muted-foreground",
};

function timeAgo(date) {
  if (!date) return "—";
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function prettyAction(action) {
  if (!action) return "Event";
  return action.split(/[._]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Read state is per-workspace, persisted in localStorage. The backend audit log is append-only,
// so there is no server-side "read" flag — this is a client-side "seen" marker.
function readKey(wsId) { return `nexusai:notif:read:${wsId}`; }
function loadRead(wsId) {
  try { return new Set(JSON.parse(localStorage.getItem(readKey(wsId)) || "[]")); } catch { return new Set(); }
}
function saveRead(wsId, set) {
  try { localStorage.setItem(readKey(wsId), JSON.stringify([...set])); } catch {}
}

// Live notification feed backed by the workspace audit log. The bell badge shows the count of
// unread events; the dropdown lists the most recent entries with contextual icons and timestamps.
export default function NotificationsDropdown() {
  const { workspace } = useWorkspace();
  const [logs, setLogs] = useState([]);
  const [readSet, setReadSet] = useState(() => new Set());
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const rows = (await base44.entities.AuditLog.filter({ workspace_id: workspace.id }, { sort: "-created_date", limit: 30 })).items || [];
      setLogs(rows);
    } catch {}
  }, [workspace]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (workspace) setReadSet(loadRead(workspace.id)); }, [workspace]);

  // Poll for new notifications while the dropdown is closed.
  useEffect(() => {
    if (!workspace || open) return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [workspace, open, load]);

  const unread = useMemo(() => logs.filter((l) => !readSet.has(l.id)), [logs, readSet]);

  const markAllRead = useCallback(() => {
    if (!workspace) return;
    const next = new Set(logs.map((l) => l.id));
    setReadSet(next);
    saveRead(workspace.id, next);
  }, [workspace, logs]);

  const markRead = useCallback((id) => {
    if (!workspace) return;
    setReadSet((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveRead(workspace.id, next);
      return next;
    });
  }, [workspace]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="relative p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors outline-none" aria-label="Notifications">
        <Bell className="h-4 w-4" />
        {unread.length > 0 && (
          <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold grid place-items-center ring-2 ring-background">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <DropdownMenuLabel className="flex items-center justify-between px-3 py-2.5">
          <span>Notifications</span>
          <div className="flex items-center gap-2">
            {unread.length > 0 && <span className="text-[11px] font-normal text-muted-foreground">{unread.length} new</span>}
            {unread.length > 0 && (
              <button onClick={markAllRead} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors" title="Mark all as read">
                <CheckCheck className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="m-0" />
        <div className="max-h-80 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              <Bell className="h-6 w-6 mx-auto mb-2 text-muted-foreground/30" />
              No notifications yet.
            </div>
          ) : (
            logs.map((l) => {
              const Icon = ICONS[l.action] || Info;
              const tone = TONES[l.action] || "text-muted-foreground";
              const isUnread = !readSet.has(l.id);
              const to = l.project_id ? `/projects/${l.project_id}` : "/analytics";
              return (
                <Link
                  key={l.id}
                  to={to}
                  onClick={() => { markRead(l.id); setOpen(false); }}
                  className={`relative flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0 ${isUnread ? "bg-primary/5" : ""}`}
                >
                  {isUnread && <span className="absolute left-1 mt-1.5 h-1.5 w-1.5 rounded-full bg-primary" />}
                  <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${tone}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] text-foreground truncate">{LABELS[l.action] || prettyAction(l.action)}</div>
                    {/* Scheduled-workflow events carry the workflow goal in metadata — show it as the sub-line. */}
                    <div className="text-[11px] text-muted-foreground truncate">{l.metadata?.goal || l.resource}</div>
                  </div>
                  <span className="text-[10px] text-muted-foreground/60 shrink-0 whitespace-nowrap">{timeAgo(l.created_date)}</span>
                </Link>
              );
            })
          )}
        </div>
        <DropdownMenuSeparator className="m-0" />
        <Link to="/analytics" onClick={() => setOpen(false)} className="flex items-center justify-center px-3 py-2.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
          View all activity
        </Link>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}