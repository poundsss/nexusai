import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { toast } from "@/components/ui/use-toast";

const ACTIVE = ["QUEUED", "BUILDING", "DEPLOYING", "VERIFYING"];

const envOf = (d) => d.environment || "production";

// Deployments run server-side; this only mirrors their state. Closing the tab does not
// interrupt a deployment, and reopening picks the live one back up.
export default function useDeployments(projectId, project) {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    if (!projectId) return [];
    try {
      const d = await workspaceRead("deployments", { project_id: projectId, limit: 30 });
      const rows = d.deployments || [];
      setDeployments(rows);
      setError(null);
      setLoading(false);
      return rows;
    } catch (e) {
      // A failed history request must not leave the spinner running: show the server's
      // classified error instead. A later successful load clears it.
      setLoading(false);
      setError(e.response?.data?.error || e.message || "Deployment history could not be loaded.");
      return [];
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Poll only while something is in flight.
  useEffect(() => {
    const active = deployments.some((d) => ACTIVE.includes(d.status));
    clearTimeout(timer.current);
    if (active) timer.current = setTimeout(load, 4000);
    return () => clearTimeout(timer.current);
  }, [deployments, load]);

  const call = useCallback(async (payload) => {
    setWorking(true);
    try {
      const res = await base44.functions.invoke("deployProject", { project_id: projectId, ...payload });
      await load();
      setError(null);
      return res.data;
    } catch (e) {
      // Surface the server's own classified error (402/409/404 and friends) through the
      // existing toast pattern; the failed action simply does nothing.
      const message = e.response?.data?.error || e.message || "The deployment request failed.";
      setError(message);
      toast({ variant: "destructive", title: "Deployment request failed", description: message });
      return null;
    } finally { setWorking(false); }
  }, [projectId, load]);

  // What an environment serves is DERIVED from the deployments, exactly like the server does
  // it: the newest LIVE, non-superseded deployment of that environment. The project's pointer
  // is only a cache, so a mid-switch interruption never makes the UI show the app as down.
  const liveIn = (environment) => deployments.find((d) => envOf(d) === environment && d.status === "LIVE" && !d.superseded_at) || null;
  const activeIn = (environment) => deployments.find((d) => envOf(d) === environment && ACTIVE.includes(d.status)) || null;

  const current = liveIn("production");
  return {
    deployments, loading, working, error, current, reload: load,
    live: { staging: liveIn("staging"), production: current },
    active: { staging: activeIn("staging"), production: activeIn("production") },
    currentIdFor: (environment) => (environment === "staging" ? project?.staging_deployment_id : project?.production_deployment_id) || null,
    deploy: (environment = "production", version_id) => call({ action: "deploy", environment, version_id }),
    promote: (to = "production", from = "staging") => call({ action: "promote", environment: to, from_environment: from }),
    rollback: (deployment_id, environment = "production") => call({ action: "rollback", deployment_id, environment }),
    cancel: (deployment_id) => call({ action: "cancel", deployment_id }),
  };
}