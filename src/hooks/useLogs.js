import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";

// Runtime-logs data access for one application. Every read goes through the `logs` operator API,
// which authorizes the caller against the project server-side — the browser only supplies a
// project id as a lookup key and only receives bounded, project-scoped rows.

// UI-only presentation labels for the certified TraceEvent event_type enum (plus "audit" for
// AuditLog-sourced rows). No event type is invented; these are friendly filter labels.
export const LOG_EVENT_TYPES = [
  { value: "", label: "All types" },
  { value: "function_exec", label: "Function calls" },
  { value: "mcp_call", label: "Integrations (MCP)" },
  { value: "tool_call", label: "Tool calls" },
  { value: "frontend_error", label: "User events (frontend)" },
  { value: "audit", label: "Entity operations (audit)" },
  { value: "ai_run", label: "AI runs" },
  { value: "ai_run_phase", label: "AI phases" },
  { value: "ai_run_step", label: "AI steps" },
  { value: "background_job", label: "Background jobs" },
  { value: "deployment", label: "Deployments" },
  { value: "diagnostic_query", label: "Diagnostics" },
];

export function useLogs(workspace) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [eventType, setEventType] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [events, setEvents] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-created_date", limit: 50 }).then((d) => {
      const rows = d.projects || [];
      setProjects(rows);
      setProjectId((cur) => cur || rows[0]?.id || "");
    });
  }, [workspace]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("logs", {
        action: "events", project_id: projectId,
        params: { event_type: eventType || null, errors_only: errorsOnly, limit: 50, offset: 0 },
      });
      setEvents(res.data.events || []);
      setHasMore(!!res.data.has_more);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Logs unavailable");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, eventType, errorsOnly]);

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (ev) => {
    setSelected(ev);
    setDetail(null);
    setDetailLoading(true);
    try {
      const params = ev.trace_id ? { trace_id: ev.trace_id } : { source: ev.source, id: ev.id };
      const res = await base44.functions.invoke("logs", { action: "detail", project_id: projectId, params });
      setDetail(res.data);
    } catch (e) {
      setDetail({ error: e.response?.data?.error || e.message || "Detail unavailable" });
    } finally {
      setDetailLoading(false);
    }
  }, [projectId]);

  return {
    projects, projectId, setProjectId, eventType, setEventType, errorsOnly, setErrorsOnly,
    events, hasMore, loading, error, reload: load, openDetail, selected, detail, detailLoading,
  };
}