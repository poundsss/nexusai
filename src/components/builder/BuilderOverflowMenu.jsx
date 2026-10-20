import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  MoreHorizontal, UserRound, FlaskConical, Github, FileCode2, GitCompareArrows, Megaphone,
  Activity, Hammer, Download, Bot, HelpCircle, PanelRight,
} from "lucide-react";

// Base44's overflow menu, in its exact order; the two trailing entries (Context panel,
// Run build) are this workspace's own existing actions and stay reachable here.
const ACTIONS = [
  { id: "act_as_user", label: "Act as a user", icon: UserRound },
  { id: "testing_agent", label: "Testing agent", icon: FlaskConical },
  { id: "launchpad", label: "Launchpad submission", icon: Megaphone },
  { id: "github", label: "GitHub connection", icon: Github },
  { id: "page_files", label: "This page's files", icon: FileCode2 },
  { id: "compare_live", label: "Compare with live code", icon: GitCompareArrows },
  { id: "activity", label: "Activity monitor", icon: Activity, badge: true },
  { id: "export_zip", label: "Export project as ZIP", icon: Download },
  { id: "coding_agent", label: "Send to Coding Agent", icon: Bot },
  { id: "context", label: "Context panel", icon: PanelRight },
  { id: "run_build", label: "Run build", icon: Hammer },
];

// The header's overflow menu — every entry lands on an existing surface: live preview,
// the agent workspace, source control, the editor, the diff/activity panels, a client-side
// ZIP export or the GitHub export the Coding Agent consumes.
export default function BuilderOverflowMenu({ onAction, building, activityCount = 0, projectId }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const cls = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="More Builder actions"
        title="More actions"
        className="grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-60 rounded-lg border border-border bg-popover p-1 shadow-md">
          {ACTIONS.map(({ id, label, icon: Icon, to, badge }) => {
            const disabled = id === "run_build" && building;
            const linkTo = id === "testing_agent" ? (projectId ? `/testing-agent?project=${projectId}` : "/testing-agent") : to;
            const tail = badge && activityCount > 0 ? (
              <span className="ml-auto rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-semibold leading-none text-background">{activityCount}</span>
            ) : null;
            const row = linkTo ? (
              <Link key={id} to={linkTo} onClick={() => setOpen(false)} className={cls + " hover:bg-muted"}>
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />{label}
              </Link>
            ) : (
              <button
                key={id}
                onClick={() => { setOpen(false); onAction(id); }}
                disabled={disabled}
                className={cls + (disabled ? " opacity-50" : " hover:bg-muted")}
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />{label}{tail}
              </button>
            );
            return row;
          })}
          <div className="my-1 h-px bg-border" />
          <Link to="/help" onClick={() => setOpen(false)} className={cls + " text-muted-foreground hover:bg-muted"}>
            <HelpCircle className="h-3.5 w-3.5" />Help center
          </Link>
        </div>
      )}
    </div>
  );
}