import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Loader2, Play, FlaskConical, CheckCircle2, Ban, ArrowLeft } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import SuggestionPanel from "@/components/testingagent/SuggestionPanel";
import QaRunList from "@/components/testingagent/QaRunList";
import QaRunResult from "@/components/testingagent/QaRunResult";

// Testing Agent — the confirmed, NON-BROWSER portion of the Base44 Testing Agent parity.
// Reuses the existing `qa` control plane (plan / suggest / run / get / list / delete), the
// existing runtimeVerify engine, the existing QaRun entity and project authorization.
// Browser-only capabilities (cloud-browser execution, automatic test-user sign-in, real-time
// watching, browser-step Activity, browser-flow Test Again) are shown as an explicit
// unavailable state rather than simulated.
const BROWSER_UNAVAILABLE = [
  { label: "Browser session execution" },
  { label: "Automatic test-user sign-in" },
  { label: "Real-time browser watching" },
  { label: "Browser-step Activity" },
  { label: "Browser-flow Test Again" },
];

export default function TestingAgent() {
  const [params, setParams] = useSearchParams();
  const { workspace } = useWorkspace();
  const projectId = params.get("project");

  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [loadingProject, setLoadingProject] = useState(true);

  const [plan, setPlan] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Load workspace projects for the picker (only used when no ?project= is present).
  useEffect(() => {
    if (projectId || !workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-created_date", limit: 50 })
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
  }, [projectId, workspace]);

  const loadProject = useCallback(async (id) => {
    if (!id) return;
    setLoadingProject(true);
    try {
      const p = (await workspaceRead("project", { project_id: id })).project;
      setProject(p);
    } catch (e) {
      setProject(null);
      toast({ variant: "destructive", title: "Could not load project", description: e.response?.data?.error || e.message });
    } finally { setLoadingProject(false); }
  }, []);

  // Load the deterministic smoke plan + existing run history for the selected project.
  const loadPlanAndRuns = useCallback(async (id) => {
    if (!id) return;
    try {
      const [planRes, runsRes] = await Promise.all([
        base44.functions.invoke("qa", { action: "plan", project_id: id }),
        base44.functions.invoke("qa", { action: "list", project_id: id, limit: 20 }),
      ]);
      const tests = planRes.data?.plan || [];
      setPlan(tests);
      setSelected(new Set(tests.map((t) => t.id)));
      setRuns(runsRes.data?.qa_runs || []);
    } catch (e) {
      toast({ variant: "destructive", title: "Could not load tests", description: e.response?.data?.error || e.message });
    }
  }, []);

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
      loadPlanAndRuns(projectId);
    } else {
      setProject(null); setPlan([]); setScenarios([]); setSelected(new Set()); setRuns([]);
    }
  }, [projectId, loadProject, loadPlanAndRuns]);

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const addScenarios = (list) => {
    setScenarios((prev) => {
      const existing = new Set(prev.map((s) => s.id));
      const merged = [...prev, ...list.filter((s) => !existing.has(s.id))];
      // Scenario tests are not runnable; they are never selected for smoke execution.
      setSelected((sel) => new Set([...sel].filter((id) => !list.some((s) => s.id === id))));
      return merged;
    });
  };

  const selectedSmokeIds = useMemo(
    () => plan.filter((t) => selected.has(t.id)).map((t) => t.id),
    [plan, selected]
  );

  const runSelected = async () => {
    if (!projectId || busy || selectedSmokeIds.length === 0) return;
    setBusy(true);
    try {
      const res = await base44.functions.invoke("qa", { action: "run", project_id: projectId, test_ids: selectedSmokeIds });
      const r = res.data?.qa_run;
      toast({ title: `QA ${r?.status || "started"}`, description: `${r?.passed || 0} passed · ${r?.failed || 0} failed · ${r?.skipped || 0} skipped` });
      await loadPlanAndRuns(projectId);
      if (r?.id) setSelectedRun(r.id);
    } catch (e) {
      toast({ variant: "destructive", title: "QA run failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  };

  const rerunTest = async (testId) => {
    if (!projectId || !testId) return;
    setBusyId(`rerun:${testId}`);
    try {
      const res = await base44.functions.invoke("qa", { action: "run", project_id: projectId, test_ids: [testId] });
      const r = res.data?.qa_run;
      toast({ title: `Test Again — ${r?.status || "done"}`, description: `${r?.passed || 0} passed · ${r?.failed || 0} failed` });
      await loadPlanAndRuns(projectId);
      if (r?.id) setSelectedRun(r.id);
    } catch (e) {
      toast({ variant: "destructive", title: "Test Again failed", description: e.response?.data?.error || e.message });
    } finally { setBusyId(null); }
  };

  const deleteRun = async (runId) => {
    if (!projectId || !runId) return;
    setBusyId(runId);
    try {
      await base44.functions.invoke("qa", { action: "delete", project_id: projectId, qa_run_id: runId });
      if (selectedRun === runId) setSelectedRun(null);
      await loadPlanAndRuns(projectId);
      toast({ title: "QA run deleted" });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not delete", description: e.response?.data?.error || e.message });
    } finally { setBusyId(null); }
  };

  const [runDetail, setRunDetail] = useState(null);
  useEffect(() => {
    if (!selectedRun || !projectId) { setRunDetail(null); return; }
    let live = true;
    base44.functions.invoke("qa", { action: "get", project_id: projectId, qa_run_id: selectedRun })
      .then((res) => { if (live) setRunDetail(res.data?.qa_run || null); })
      .catch(() => { if (live) setRunDetail(null); });
    return () => { live = false; };
  }, [selectedRun, projectId, runs]);

  if (!projectId) {
    return (
      <div className="min-h-full p-6 max-w-2xl mx-auto">
        <h1 className="text-[20px] font-semibold flex items-center gap-2"><FlaskConical className="h-5 w-5" />Testing Agent</h1>
        <p className="text-[13px] text-muted-foreground mt-2">Select a project to test, or open the Testing Agent from a project's <span className="font-medium">More actions → Testing agent</span> menu.</p>
        <ul className="mt-4 space-y-1.5">
          {(projects || []).length === 0 ? <li className="text-[12px] text-muted-foreground/60">No projects found.</li> :
            projects.map((p) => (
              <li key={p.id}>
                <button onClick={() => setParams({ project: p.id })} className="w-full text-left rounded-md border border-border px-3 py-2 hover:bg-muted transition-colors">
                  <div className="text-[13px] font-medium">{p.name}</div>
                  <div className="text-[11px] text-muted-foreground">status: {p.status} · v{p.version_count ?? 0}</div>
                </button>
              </li>
            ))}
        </ul>
      </div>
    );
  }

  if (loadingProject) return <div className="min-h-full grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="min-h-full">
      <div className="border-b border-border px-4 py-2.5 flex items-center gap-2">
        <Link to={`/builder/${projectId}`} className="grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"><ArrowLeft className="h-4 w-4" /></Link>
        <FlaskConical className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-[14px] font-semibold">Testing Agent</h1>
        <span className="text-[12px] text-muted-foreground/70 truncate">{project?.name || projectId}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-4">
        <div className="space-y-3">
          <SuggestionPanel projectId={projectId} onAdd={addScenarios} />

          <div className="rounded-md border border-border">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Test list</span>
              <span className="text-[10.5px] text-muted-foreground/70">{selectedSmokeIds.length} selected</span>
              <button onClick={runSelected} disabled={busy || selectedSmokeIds.length === 0} className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-2 py-1 text-[11px] font-semibold hover:opacity-90 disabled:opacity-50">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}Run selected
              </button>
            </div>
            <ul className="divide-y divide-border/40">
              {plan.map((t) => (
                <li key={t.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[12px]">
                  <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} className="h-3 w-3 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] uppercase text-muted-foreground/70">{t.category}</span>
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    </div>
                    <div className="text-foreground">{t.target}</div>
                    <div className="text-[11px] text-muted-foreground/70 break-words">{t.description}</div>
                  </div>
                </li>
              ))}
              {scenarios.map((s) => (
                <li key={s.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[12px] bg-amber-500/[0.03]">
                  <Ban className="h-3 w-3 mt-0.5 text-amber-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] uppercase text-amber-600">scenario</span>
                      <span className="text-[10px] text-muted-foreground/60">browser-only</span>
                    </div>
                    <div className="text-foreground">{s.label}</div>
                    <div className="text-[11px] text-muted-foreground/70 break-words">{s.description}</div>
                    <div className="text-[10.5px] text-amber-600 mt-0.5">Browser execution is not available in this runtime — not run.</div>
                  </div>
                </li>
              ))}
              {plan.length === 0 && scenarios.length === 0 && <li className="px-2.5 py-1.5 text-[11px] text-muted-foreground/60">No tests yet.</li>}
            </ul>
          </div>
        </div>

        <div className="space-y-3">
          {selectedRun && runDetail ? (
            <QaRunResult run={runDetail} onRerun={rerunTest} onDelete={deleteRun} busyId={busyId} />
          ) : (
            <div className="rounded-md border border-border p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Run history</div>
              <QaRunList runs={runs} onSelect={setSelectedRun} selectedId={selectedRun} />
            </div>
          )}
          {!(selectedRun && runDetail) && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Not available in this runtime</div>
              <ul className="space-y-1">
                {BROWSER_UNAVAILABLE.map((b) => (
                  <li key={b.label} className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <Ban className="h-3 w-3 text-amber-600" />{b.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}