import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

export const TERMINAL_RUN_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];

// Follows a persisted AI run by id. Runs execute in the background, so the browser only
// observes state: it polls the run record and stops when the run reaches a terminal state.
// Nothing here drives execution, which is why a refresh or a closed tab cannot interrupt a run.
export function useRunTracker(onFinished) {
  const [run, setRun] = useState(null);
  const runIdRef = useRef(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const track = useCallback((runId) => {
    runIdRef.current = runId;
    setRun({ id: runId, status: "QUEUED", steps: [] });
  }, []);

  useEffect(() => {
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const fresh = await base44.entities.AIRun.get(runIdRef.current).catch(() => null);
      if (cancelled || !fresh) return;
      setRun(fresh);
      if (TERMINAL_RUN_STATUSES.includes(fresh.status)) {
        clearInterval(timer);
        const finished = finishedRef.current;
        await finished?.(fresh);
        // Always clear the terminal run: effect cleanup may have flipped `cancelled`
        // during the await, but the run is over either way and the Builder must exit
        // its "sending" state. Non-terminal runs keep the existing cancellation behavior.
        setRun(null);
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [run]);

  return { run, tracking: !!run, track };
}