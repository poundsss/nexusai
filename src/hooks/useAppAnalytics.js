import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";

// Operator analytics data access for one application.
//
// Every read goes through the analytics operator API, which authorizes the caller against the
// project server-side — the browser only supplies a project id as a lookup key and never receives
// data for a project it cannot access. Ranges are bounded here too (the server clamps again), and
// only aggregated / paginated results are fetched, never the full event stream.
export const RANGE_OPTIONS = [
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

const rangeParams = (days) => ({ from: new Date(Date.now() - days * 86400000).toISOString(), to: new Date().toISOString() });

export function useAppAnalytics(workspace) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-created_date", limit: 50 }).then((d) => {
      const rows = d.projects || [];
      setProjects(rows);
      setProjectId((current) => current || rows[0]?.id || "");
    });
  }, [workspace]);

  // One authorized operator call. Failures surface as-is so the UI can show the server's reason
  // (including a permission refusal) instead of inventing one.
  const query = useCallback(async (action, params = {}) => {
    const res = await base44.functions.invoke("analytics", { action, project_id: projectId, params: { ...rangeParams(days), ...params } });
    return res.data;
  }, [projectId, days]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [overview, errors, retention, sales] = await Promise.all([
        query("overview"), query("errors"), query("retention", { period_days: 7 }), query("sales"),
      ]);
      setData({ overview, errors, retention, sales });
    } catch (e) {
      setData(null);
      setError(e.response?.data?.error || e.message || "Analytics unavailable");
    } finally {
      setLoading(false);
    }
  }, [projectId, query]);

  useEffect(() => { load(); }, [load]);

  return { projects, projectId, setProjectId, days, setDays, data, loading, error, reload: load, query };
}