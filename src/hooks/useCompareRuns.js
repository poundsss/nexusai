import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { TERMINAL_RUN_STATUSES } from "./useRunTracker";

// Follows TWO persisted AI runs by id (the compare feature runs the same prompt under two
// models in parallel). Polls both AIRun records and clears when both reach a terminal state.
// Nothing here drives execution — the background executors own that; the browser only observes.
export function useCompareRuns(onFinished) {
  const [ids, setIds] = useState(null);
  const [runA, setRunA] = useState(null);
  const [runB, setRunB] = useState(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const start = useCallback((aId, bId) => {
    setIds({ a: aId, b: bId });
    setRunA({ id: aId, status: "QUEUED", steps: [] });
    setRunB({ id: bId, status: "QUEUED", steps: [] });
  }, []);

  const clear = useCallback(() => { setIds(null); setRunA(null); setRunB(null); }, []);

  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const [a, b] = await Promise.all([
        base44.entities.AIRun.get(ids.a).catch(() => null),
        base44.entities.AIRun.get(ids.b).catch(() => null),
      ]);
      if (cancelled) return;
      if (a) setRunA(a);
      if (b) setRunB(b);
      const aDone = !a || TERMINAL_RUN_STATUSES.includes(a.status);
      const bDone = !b || TERMINAL_RUN_STATUSES.includes(b.status);
      if (aDone && bDone) {
        clearInterval(timer);
        await finishedRef.current?.(a, b);
        if (!cancelled) { setIds(null); setRunA(null); setRunB(null); }
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [ids]);

  return { start, clear, runA, runB, tracking: !!ids };
}