import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import GrowProjectPicker from "@/components/growthagent/GrowProjectPicker";
import CompanyMonitoring from "@/components/growthagent/CompanyMonitoring";
export default function GrowCompany({ workspace }) {
  const [projectId, setProjectId] = useState("");
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (workspace?.id) workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 1 }).then((d) => setProjectId(d.projects?.[0]?.id || "")); }, [workspace?.id]);
  useEffect(() => { if (!projectId) return; let alive = true; setData(null); setError(""); Promise.all([base44.functions.invoke("myBusiness", { action: "company_get", project_id: projectId }), base44.functions.invoke("myBusiness", { action: "status", project_id: projectId })]).then(([c, s]) => { if (alive) { setData(c.data); setStatus(s.data); } }).catch((e) => { if (alive) setError(e.response?.data?.error || e.message); }); return () => { alive = false; }; }, [projectId]);
  const act = async (action, args = {}, append = false) => {
    setBusy(true); setError("");
    try { const out = await base44.functions.invoke("myBusiness", { action, project_id: projectId, ...args });
      if (action === "company_get") setData((old) => ({ ...out.data, observations: append ? [...old.observations, ...out.data.observations] : out.data.observations }));
      else { const fresh = await base44.functions.invoke("myBusiness", { action: "company_get", project_id: projectId }); setData(fresh.data); }
    } catch (e) { setError(e.response?.data?.error || e.message); } finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-4xl space-y-6 p-6 text-foreground bg-card rounded-xl m-4">
    <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={setProjectId} />
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!projectId ? <p>Select or create a project first.</p> : !data ? <p>Loading company monitoring…</p> : <CompanyMonitoring data={data} busy={busy} act={act} />}
    {status && <section className="border-t border-border pt-4"><h2 className="font-heading text-lg">My Business / Google Business Profile</h2><p className="mt-2 text-sm text-muted-foreground">{status.blocker}</p><p className="mt-1 text-sm">{status.code} · No listing claimed or configured.</p></section>}
  </div>;
}