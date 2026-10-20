import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useProjectData } from "@/hooks/useProjectData";
import { useRunTracker, TERMINAL_RUN_STATUSES } from "@/hooks/useRunTracker";
import { useCompareRuns } from "@/hooks/useCompareRuns";
import { toast } from "@/components/ui/use-toast";
import CenterCanvas from "@/components/builder/CenterCanvas";
import ContextPanel from "@/components/builder/ContextPanel";
import PreviewPane from "@/components/builder/PreviewPane";
import CodeViewer from "@/components/builder/CodeViewer";
import DataPane from "@/components/builder/DataPane";
import SecretsPane from "@/components/builder/SecretsPane";
import IntegrationsPane from "@/components/builder/IntegrationsPane";
import ChatPane from "@/components/builder/ChatPane";
import ActivityBar from "@/components/builder/ActivityBar";
import { useAgentRun } from "@/hooks/useAgentRun";
import DeployPane from "@/components/builder/DeployPane";
import useDeployments from "@/hooks/useDeployments";
import useDomains from "@/hooks/useDomains";
import GitHubPane from "@/components/builder/GitHubPane";
import useGitHub from "@/hooks/useGitHub";
import { useBuilderCredits } from "@/hooks/useBuilderCredits";
import UnifiedBuilderHeader from "@/components/builder/BuilderHeader";
import PublishModal from "@/components/builder/PublishModal";
import PlansModal from "@/components/builder/PlansModal";
import CompareLiveDialog from "@/components/builder/CompareLiveDialog";
import { downloadProjectZip } from "@/lib/zipExport";
import PageOverview from "@/components/builder/PageOverview";
import DashboardView from "@/components/builder/DashboardView";
import LogicPane from "@/components/builder/LogicPane";
import AgentsPane from "@/components/builder/AgentsPane";
import SettingsPane from "@/components/builder/SettingsPane";
import LaunchpadPane from "@/components/builder/LaunchpadPane";
import VersionsPane from "@/components/builder/VersionsPane";
import VersionHistoryPanel from "@/components/builder/VersionHistoryPanel";
import PanelResizer from "@/components/builder/PanelResizer";
import VisualEditToolbar from "@/components/builder/VisualEditToolbar";
import AppUsersPane from "@/components/builder/AppUsersPane";
import { derivePages } from "@/components/builder/pageRoutes";
import { bundlePreview } from "@/lib/runtime/previewBundle";
import usePackageModules from "@/hooks/usePackageModules";

const VIEW_TITLES = {
  preview: "Preview", dashboard: "Dashboard", code: "Build", data: "Data",
  integrations: "Components", secrets: "Secrets", github: "Source control",
  deploy: "Deploy", logic: "Logic", agents: "Agents", versions: "Versions",
  settings: "Settings", launchpad: "Launchpad", app_users: "App Users",
};

const VIEW_IDS = ["preview", "dashboard", "code", "data", "logic", "integrations", "agents", "versions", "deploy", "settings", "secrets", "github", "launchpad", "app_users"];

// Visual Edit context folded into the AI prompt (no backend field, no provenance claim). The
// page file is contextual AI guidance derived from the EXISTING route→file map (derivePages);
// the element descriptor is what the picker captured. No 1:1 DOM→source mapping is claimed.
function elementEditContext(el, route, files) {
  if (!el) return null;
  const pageFile = (derivePages(files || []).find((p) => p.route === route) || {}).file || null;
  const tag = el.tag || "element";
  const text = el.text ? `\nText content: ${el.text}` : "";
  const html = el.html ? `\nHTML: ${el.html}` : "";
  const pageLine = pageFile ? `Page file: ${pageFile}` : `Current route: ${route || "/"}`;
  return `Visual edit — the user selected one element in the live preview to edit. ${pageLine}\nElement: <${tag}>${text}${html}\nApply the instruction to the page's JSX/Tailwind that renders this element.`;
}

export default function Builder() {
  const { projectId: id } = useParams();
  const { project, files, entities, versions, runs, builds, conversation, messages, loading, error, reload } = useProjectData(id);
  // Search params are the command palette's entry point into the builder: ?file=<path> opens the
  // file in Build view, ?entity=<name> jumps to the Data pane, ?publish=1 opens the Publish modal.
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState(() => {
    if (searchParams.get("file")) return "code";
    if (searchParams.get("entity")) return "data";
    if (VIEW_IDS.includes(searchParams.get("view"))) return searchParams.get("view");
    try { const saved = localStorage.getItem("builder:view:" + id); if (saved && VIEW_IDS.includes(saved)) return saved; } catch { }
    return "preview";
  });
  const [selectedFile, setSelectedFile] = useState(() => searchParams.get("file"));
  const [selectedEntity, setSelectedEntity] = useState(() => searchParams.get("entity"));
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [building, setBuilding] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const [runtimeErrors, setRuntimeErrors] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const toggleHistory = () => { setHistoryOpen((o) => !o); setChatCollapsed(false); setChatOpen(true); };
  const [contextOpen, setContextOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [activityRequest, setActivityRequest] = useState(0);
  const [chatDraft, setChatDraft] = useState(null);
  const prefillChat = useCallback((text) => { setChatDraft(text); setChatOpen(true); }, []);
  const [modelId, setModelId] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("model") || null; } catch { return null; }
  });
  const [pagesOpen, setPagesOpen] = useState(false);
  const [previewRoute, setPreviewRoute] = useState(null);
  const [viewport, setViewport] = useState("desktop");
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [chatWidth, setChatWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem("builder:chatWidth:" + id)); return saved > 0 ? saved : 380; } catch { return 380; }
  });
  useEffect(() => { try { localStorage.setItem("builder:chatWidth:" + id, String(chatWidth)); } catch {} }, [id, chatWidth]);
  // Apply palette jumps (?file / ?entity / ?publish) whenever the URL changes, then clear those
  // params so a repeated jump to the same target re-triggers and a later reload never reopens a
  // publish modal the user already closed. Normal in-builder selection never touches the URL.
  useEffect(() => {
    let changed = false;
    const file = searchParams.get("file");
    const entity = searchParams.get("entity");
    const publish = searchParams.get("publish") === "1";
    if (file) { setSelectedFile(file); setView("code"); setChatOpen(false); changed = true; }
    if (entity) { setSelectedEntity(entity); setView("data"); changed = true; }
    if (publish && project) { setPublishOpen(true); changed = true; }
    if (changed) {
      const next = new URLSearchParams(searchParams);
      next.delete("file"); next.delete("entity"); next.delete("publish");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, project, setSearchParams]);
  // Visual Edit: opt-in preview element picker + the captured element descriptor. The
  // descriptor is folded into the AI prompt (no backend field); selecting an element ends
  // picking so normal preview behavior resumes immediately.
  const [picker, setPicker] = useState(false);
  const [selectedElement, setSelectedElement] = useState(null);
  const togglePicker = useCallback(() => {
    setPicker((p) => { const next = !p; if (next) setView("preview"); return next; });
  }, []);
  const onElementSelect = useCallback((m) => {
    if (!m || m.canceled) return;
    setSelectedElement(m);
    setPicker(false);
  }, []);
  const clearElement = useCallback(() => setSelectedElement(null), []);
  // Visual Edit toolbar: a deterministic, conflict-safe source edit (no AI run). Returns an error
  // object for the toolbar; unresolvable/ambiguous elements offer the AI fallback.
  const applyVisualEdit = useCallback(async (changes) => {
    const pageFile = (derivePages(files || []).find((p) => p.route === previewRoute) || {}).file || null;
    try {
      await base44.functions.invoke("projectEdit", { action: "visual_edit", project_id: id, expected_version: project?.version_count ?? 0, page_file: pageFile, element: selectedElement, changes });
    } catch (e) {
      const d = e.response?.data || {};
      return { message: d.error || e.message, fallback: String(d.code || "").startsWith("VISUAL_EDIT_") && d.code !== "VISUAL_EDIT_INVALID" };
    }
    await reload();
    setPreviewRefresh((n) => n + 1);
    setSelectedElement(null);
    toast({ title: "Change applied", description: "Saved as a new version — restore it from Versions to undo." });
    return null;
  }, [id, project?.version_count, files, previewRoute, selectedElement, reload]);
  const autoPrompted = useRef(false);
  const resumed = useRef(false);
  const credits = useBuilderCredits();

  useEffect(() => { try { localStorage.setItem("builder:view:" + id, view); } catch { } }, [id, view]);

  // Builder settings (documented Base44 "More options"): Auto approve + Custom Instructions,
  // project-scoped, persisted through the authorized projectBuilderSettings surface. Auto
  // approve toggles immediately (no Save); Custom Instructions save through their dialog. Both
  // are loaded once per project; the safety engine and the Build prompt read them server-side.
  const [builderSettings, setBuilderSettings] = useState({ auto_approve: false, custom_instructions: "", design_system_id: null, design_system_name: null });
  // "On a branch" = the active ProjectBranch is not the default "Main". Custom Instructions is
  // hidden while on a branch per the doc; Auto approve stays (its branch behavior is UNKNOWN).
  const [onBranch, setOnBranch] = useState(false);
  useEffect(() => {
    if (!id) return;
    base44.functions.invoke("projectBuilderSettings", { action: "get", project_id: id })
      .then((res) => setBuilderSettings({ auto_approve: !!res.data?.auto_approve, custom_instructions: res.data?.custom_instructions || "", design_system_id: res.data?.design_system_id || null, design_system_name: res.data?.design_system_name || null }))
      .catch(() => {});
    base44.functions.invoke("branches", { project_id: id, action: "list" })
      .then((res) => setOnBranch((res.data?.branches || []).some((b) => b.is_active && !b.is_default)))
      .catch(() => {});
  }, [id]);
  const toggleAutoApprove = useCallback(async () => {
    const next = !builderSettings.auto_approve;
    const prev = builderSettings;
    setBuilderSettings((s) => ({ ...s, auto_approve: next }));
    try {
      const res = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: id, auto_approve: next });
      setBuilderSettings({ auto_approve: !!res.data?.auto_approve, custom_instructions: res.data?.custom_instructions ?? prev.custom_instructions, design_system_id: res.data?.design_system_id ?? prev.design_system_id, design_system_name: res.data?.design_system_name ?? prev.design_system_name });
    } catch (e) {
      setBuilderSettings(prev);
      toast({ variant: "destructive", title: "Auto approve could not be updated", description: e.response?.data?.error || e.message });
    }
  }, [id, builderSettings]);
  const saveCustomInstructions = useCallback(async (text) => {
    try {
      const res = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: id, custom_instructions: text });
      setBuilderSettings((s) => ({ ...s, auto_approve: !!res.data?.auto_approve, custom_instructions: res.data?.custom_instructions || "", design_system_name: res.data?.design_system_name ?? s.design_system_name }));
      toast({ title: "Custom instructions saved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Custom instructions could not be saved", description: e.response?.data?.error || e.message });
    }
  }, [id]);
  const saveDesignSystem = useCallback(async (designSystemId) => {
    const prev = builderSettings;
    setBuilderSettings((s) => ({ ...s, design_system_id: designSystemId }));
    try {
      const res = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: id, design_system_id: designSystemId });
      setBuilderSettings((s) => ({ ...s, design_system_id: res.data?.design_system_id || null, design_system_name: res.data?.design_system_name || null }));
      toast({ title: designSystemId ? "Design system applied to new Builds" : "Design system cleared" });
    } catch (e) {
      setBuilderSettings(prev);
      toast({ variant: "destructive", title: "Design system could not be changed", description: e.response?.data?.error || e.message });
    }
  }, [id, builderSettings]);

  const onRunFinished = useCallback(async () => {
    await reload(); setPendingPrompt(null); setRuntimeErrors([]); credits.refresh();
    // Remount the preview iframe so a just-completed run's bundled output actually mounts.
    setPreviewRefresh((n) => n + 1);
  }, [reload, credits]);
  const { run: liveRun, tracking, track } = useRunTracker(onRunFinished);
  const agent = useAgentRun(id, reload);
  const deploy = useDeployments(id, project);
  const domains = useDomains(id);
  const github = useGitHub(id);
  const compare = useCompareRuns(async () => { await reload(); setPreviewRefresh((n) => n + 1); credits.refresh(); });
  const startCompare = useCallback(async (modelA, modelB, prompt, imageUrls) => {
    setPendingPrompt(prompt);
    try {
      const res = await base44.functions.invoke("compareModels", { project_id: id, conversation_id: conversation?.id, prompt, model_a: modelA, model_b: modelB, image_urls: imageUrls });
      compare.start(res.data.run_a_id, res.data.run_b_id);
      setChatOpen(true);
    } catch (e) {
      toast({ variant: "destructive", title: "Compare could not start", description: e.response?.data?.error || e.message });
      setPendingPrompt(null);
    }
  }, [id, conversation?.id, compare]);

  useEffect(() => {
    if (loading || resumed.current) return;
    resumed.current = true;
    const active = runs.find((r) => !TERMINAL_RUN_STATUSES.includes(r.status));
    if (active) { setPendingPrompt(active.prompt); track(active.id); }
  }, [loading, runs, track]);

  const send = useCallback(async (prompt, mode, imageUrls = []) => {
    if (mode === "agent") {
      try { await agent.start(prompt, imageUrls); }
      catch (e) { toast({ variant: "destructive", title: "Agent could not start", description: e.response?.data?.error || e.message }); }
      return;
    }
    let finalPrompt = prompt;
    if (mode === "edit") {
      const ctx = selectedElement
        ? elementEditContext(selectedElement, previewRoute, files)
        : (selectedFile ? `Focused edit — only change ${selectedFile} unless strictly necessary.` : null);
      if (ctx) finalPrompt = `${ctx}\n\n${prompt}`;
    }
    setPendingPrompt(prompt);
    try {
      const res = await base44.functions.invoke("aiRun", { project_id: id, conversation_id: conversation?.id, prompt: finalPrompt, mode, model_id: modelId, image_urls: imageUrls });
      track(res.data.run_id);
      return true;
    } catch (e) {
      toast({ variant: "destructive", title: "AI request failed", description: e.response?.data?.error || e.message });
      setPendingPrompt(null);
    }
  }, [id, conversation?.id, selectedFile, selectedElement, previewRoute, files, track, agent, modelId]);

  useEffect(() => {
    if (loading || autoPrompted.current) return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get("prompt");
    if (!p) return;
    autoPrompted.current = true;
    let images = [];
    try { const raw = params.get("images"); if (raw) images = JSON.parse(raw).filter((u) => typeof u === "string"); } catch { images = []; }
    const firstMode = params.get("mode") === "discuss" ? "discuss" : "default";
    window.history.replaceState({}, "", window.location.pathname);
    send(p, firstMode, images);
  }, [loading, send]);

  const rebuild = async () => {
    setBuilding(true);
    try {
      const res = await base44.functions.invoke("runBuild", { project_id: id });
      toast({ title: res.data.status === "success" ? "Build passed" : "Build failed", description: `${res.data.file_count} files · ${res.data.duration_ms}ms · ${res.data.errors} error(s)` });
    } finally { await reload(); setBuilding(false); }
  };

  const restore = async (version) => {
    setRestoring(version.id);
    try {
      const res = await base44.functions.invoke("restoreVersion", { project_id: id, version_id: version.id });
      toast({ title: `Restored version ${version.number}`, description: `Saved as version ${res.data.version}` });
    } catch (e) {
      toast({ variant: "destructive", title: "Restore failed", description: e.response?.data?.error || e.message });
    } finally { await reload(); setRestoring(null); }
  };

  // "Publish this version" from Version History (Base44 parity): deploys the SELECTED version to
  // production through the EXISTING deploy path (deployProject → requestDeployment(version_id)),
  // without changing the current draft. The version list is not reordered and the editor stays put.
  const [publishingVersion, setPublishingVersion] = useState(null);
  const publishVersion = async (version) => {
    setPublishingVersion(version.id);
    try {
      const res = await deploy.deploy("production", version.id);
      toast({ title: `Publishing version ${version.number}`, description: `Deploying v${version.number} to production — your current draft is kept open.` });
      void res;
    } catch (e) {
      toast({ variant: "destructive", title: "Publish could not start", description: e.response?.data?.error || e.message });
    } finally {
      setPublishingVersion(null);
    }
  };

  // Per-change Revert from a completed AI chat message. Delegates to the revertRun backend,
  // which reuses the existing version.restore capability and the existing restore primitive —
  // restoring the run's base version rolls the app back to before that change and undoes later
  // committed changes. Append-only: a new version is created, history is never rewritten.
  const [revertingRun, setRevertingRun] = useState(null);
  const revertRun = async (run) => {
    setRevertingRun(run.id);
    try {
      const res = await base44.functions.invoke("revertRun", { project_id: id, run_id: run.id });
      toast({ title: "Change reverted", description: `Restored to v${run.base_version_number} · saved as version ${res.data.version}` });
    } catch (e) {
      toast({ variant: "destructive", title: "Revert failed", description: e.response?.data?.error || e.message });
    } finally { await reload(); setRevertingRun(null); }
  };

  const deployNow = async (environment = "production") => {
    try {
      const res = await deploy.deploy(environment);
      toast({ title: `Deploying version ${res.version_number} to ${environment}`, description: `Building an immutable artifact, verifying, then switching ${environment}.` });
    } catch (e) {
      toast({ variant: "destructive", title: "Deployment could not start", description: e.response?.data?.error || e.message });
    }
  };

  const publish = () => setPublishOpen(true);

  const promoteStaging = async () => {
    try {
      const res = await deploy.promote("production", "staging");
      toast({ title: `Promoting version ${res.version_number} to production`, description: "The exact artifact staging verified is reused — nothing is rebuilt." });
    } catch (e) {
      toast({ variant: "destructive", title: "Promotion could not start", description: e.response?.data?.error || e.message });
    }
  };

  const rollbackTo = async (deploymentId, environment = "production") => {
    try {
      const res = await deploy.rollback(deploymentId, environment);
      toast({ title: `Rolling back to version ${res.version_number}`, description: "A new deployment is being created; history is preserved." });
    } catch (e) {
      toast({ variant: "destructive", title: "Rollback could not start", description: e.response?.data?.error || e.message });
    }
  };

  const exportToGitHub = async (versionId) => {
    try {
      const res = await github.exportVersion(versionId);
      toast({ title: res.duplicate ? "Already exported" : "Export started", description: res.duplicate ? `Commit ${String(res.commit_sha).slice(0, 7)} already holds this version.` : "Creating a real commit in the background." });
    } catch (e) {
      toast({ variant: "destructive", title: "Export could not start", description: e.response?.data?.error || e.message });
    }
  };

  const importFromGitHub = async (commitSha) => {
    try {
      const res = await github.importCommit(commitSha);
      toast({ title: res.duplicate ? "Already imported" : "Import started", description: res.duplicate ? `This commit is already internal version ${res.version_number}.` : "Validating the commit before creating an internal version." });
    } catch (e) {
      toast({ variant: "destructive", title: "Import could not start", description: e.response?.data?.error || e.message });
    } finally { await reload(); }
  };

  const toggleFrozen = async (file) => { await base44.functions.invoke("projectFileFreeze", { project_id: id, updates: [{ file_id: file.id, frozen: !file.frozen }] }); await reload(); };
  const openFile = (path) => { setSelectedFile(path); setView("code"); setChatOpen(false); };
  // "Resolve with AI": one repair run through the existing aiRun path, errors attached to the prompt.
  const resolveRuntimeErrors = useCallback(async (errors) => {
    const list = errors.slice(-5).map((e) => `- ${String(e).slice(0, 500)}`).join("\n");
    // Errors stay until aiRun accepts the request, so a refused request can be retried.
    const started = await send(`Fix the following runtime error(s) detected in the Preview. Change only what is needed to resolve them.\n\n${list}`, "default");
    if (started) setRuntimeErrors([]);
  }, [send]);
  const onRuntimeError = useCallback((msg) => setRuntimeErrors((e) => [...e, msg].slice(-50)), []);
  const overviewPkg = usePackageModules(id, files);

  if (loading) return (
    <div className="h-[100dvh] grid place-items-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-[12.5px] text-muted-foreground">Loading your application…</p>
      </div>
    </div>
  );
  if (error || !project) return (
    <div className="h-[100dvh] grid place-items-center p-6">
      <div className="max-w-md w-full text-center">
        <AlertCircle className="h-7 w-7 mx-auto text-destructive" />
        <h1 className="mt-4 text-lg font-semibold">Project not found</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">{error || "This project may have been deleted or you don't have access to it."}</p>
        <Link to="/projects" className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-[13px] font-semibold hover:opacity-90 transition-opacity">
          <ArrowLeft className="h-4 w-4" /> Back to applications
        </Link>
      </div>
    </div>
  );

  const file = files.find((f) => f.path === selectedFile);
  const liveUrls = {
    staging: deploy.live.staging?.deployment_url || (deploy.live.staging && project?.slug ? `/app/${project.slug}--staging` : null),
    production: deploy.live.production?.deployment_url || (deploy.live.production && project?.slug ? `/app/${project.slug}` : null),
  };
  const liveUrl = liveUrls.production;
  const pages = derivePages(files);
  const startEditing = () => {
    const target = selectedFile || pages[0]?.file || files[0]?.path;
    if (target) setSelectedFile(target);
    setView("code");
  };
  const selectPage = (route) => { setPreviewRoute(route); setView("preview"); setPagesOpen(false); };

  const headerAction = (action) => {
    if (action === "act_as_user") {
      const url = liveUrls.production || liveUrls.staging;
      if (url) window.open(url, "_blank", "noopener");
      else toast({ title: "Not live yet", description: "Publish the app first — then you can open it as an end user." });
    }
    if (action === "github") setView("github");
    if (action === "launchpad") setView("launchpad");
    if (action === "context") setContextOpen((o) => !o);
    if (action === "page_files") {
      const route = previewRoute || pages[0]?.route;
      const page = pages.find((p) => p.route === route) || pages[0];
      if (page) openFile(page.file);
      else toast({ title: "No pages yet", description: "Ask the assistant to add a page first." });
    }
    if (action === "compare_live") setCompareOpen(true);
    if (action === "activity") setActivityRequest((n) => n + 1);
    if (action === "run_build") rebuild();
    if (action === "export_zip") downloadProjectZip(project, files);
    if (action === "coding_agent") {
      if (versions[0]) exportToGitHub(versions[0].id);
      else toast({ title: "Nothing to send", description: "The project has no committed versions yet." });
    }
  };
  let overviewBundle = { srcdoc: "" };
  if (pagesOpen) {
    if (overviewPkg.error) overviewBundle = { error: overviewPkg.error };
    else if (!overviewPkg.loading) {
      try { overviewBundle = { srcdoc: bundlePreview(files, { packages: overviewPkg.packages }) }; } catch (e) { overviewBundle = { error: e.message }; }
    }
  }

  return (
    <div className="h-[100dvh] overflow-hidden flex flex-col bg-background text-foreground text-[13px]" style={{ "--chat-w": `${chatWidth}px` }}>
      {pagesOpen && (
        <PageOverview
          pages={pages} srcdoc={overviewBundle.srcdoc} bundleError={overviewBundle.error}
          onSelect={selectPage} onOpenFile={(p) => { openFile(p); setPagesOpen(false); }}
          onClose={() => setPagesOpen(false)}
        />
      )}

      {/* One unified header spanning the full width: project identity (left, chat-column-width)
          + canvas controls (right). The preview SCREEN below is a separate floating panel. */}
      <UnifiedBuilderHeader
        project={project} onView={setView} onBranchSwitched={reload}
        chatCollapsed={chatCollapsed} onToggleCollapse={() => setChatCollapsed((c) => !c)}
        chatOpen={chatOpen} onToggleChat={() => setChatOpen((o) => !o)}
        historyOpen={historyOpen} onToggleHistory={toggleHistory}
        envs={{ staging: deploy.live.staging?.version_number ?? null, production: deploy.live.production?.version_number ?? null }}
        liveUrls={liveUrls} onAction={headerAction}
        view={view} onEdit={startEditing} onOpenPages={() => setPagesOpen(true)}
        building={building}
        activityCount={runs.filter((r) => !TERMINAL_RUN_STATUSES.includes(r.status)).length + runtimeErrors.length}
        viewport={viewport} onViewport={setViewport}
        onRefresh={() => setPreviewRefresh((n) => n + 1)} pages={pages}
        onSelectRoute={(route) => { setPreviewRoute(route); setView("preview"); }}
        picker={picker} onTogglePicker={togglePicker}
        onPublish={publish} publishing={deploy.working}
        onUpgrade={() => setPlansOpen(true)}
      />

      {/* Body — chat column (flush) + the preview screen as its own floating panel. */}
      <div className="flex-1 flex min-h-0">
        <aside className={`${chatOpen ? "flex" : "hidden"} ${chatCollapsed ? "lg:hidden" : "lg:flex"} flex-col h-full w-full lg:w-[var(--chat-w)] shrink-0 bg-background`}>
          <div className="flex-1 min-h-0 w-full min-w-0">
            {historyOpen ? (
              <VersionHistoryPanel
                versions={versions} onBack={() => setHistoryOpen(false)}
                onRestore={restore} onPublish={publishVersion} onCompare={() => setView("versions")}
                restoring={restoring} publishing={publishingVersion}
              />
            ) : (
              <ChatPane
                messages={messages} runs={runs} liveRun={liveRun} sending={tracking} pendingPrompt={pendingPrompt}
                onSend={send} onOpenFile={openFile} selectedFile={selectedFile} agent={agent}
                models={credits.models} modelId={modelId} onModelChange={setModelId} credits={credits}
                draft={chatDraft} onDraftApplied={() => setChatDraft(null)}
                onRevertRun={revertRun} revertingRunId={revertingRun}
                selectedElement={selectedElement} onClearElement={clearElement}
                autoApprove={builderSettings.auto_approve}
                onToggleAutoApprove={toggleAutoApprove}
                customInstructions={builderSettings.custom_instructions}
                onSaveCustomInstructions={saveCustomInstructions}
                onBranch={onBranch}
                files={files}
                onFreezeFilesSaved={reload}
                onCompareModels={startCompare}
                designSystemId={builderSettings.design_system_id}
                designSystemName={builderSettings.design_system_name}
                projectId={id}
                onDesignSystemChange={saveDesignSystem}
                compareRunA={compare.runA}
                compareRunB={compare.runB}
                comparing={compare.tracking}
              />
            )}
          </div>
        </aside>

        {!chatCollapsed && <PanelResizer onResize={setChatWidth} currentWidth={chatWidth} />}

        {/* The preview SCREEN — a standalone floating panel, separate from the header above. */}
        <main className={`flex-1 min-w-0 h-full p-1.5 ${chatOpen ? "hidden lg:flex" : "flex"}`}>
          <div className="flex-1 min-h-0 rounded-xl overflow-hidden bg-background ring-1 ring-border/30 flex flex-col">
            <div className="h-[3px] shrink-0 w-full bg-gradient-to-r from-[#3B82F6] via-[#22d3ee] to-[#4FD1C5] bg-[length:200%_100%] animate-[gradient-pan_6s_linear_infinite]" />
            <div className="flex-1 min-h-0">
            <CenterCanvas view={view} onView={setView} title={VIEW_TITLES[view]}>
              {view === "preview" && <div className="relative h-full">
                <PreviewPane projectId={id} files={files} entities={entities} runtimeErrors={runtimeErrors} onRuntimeError={onRuntimeError} onClearErrors={() => setRuntimeErrors([])} gotoRoute={previewRoute} viewport={viewport} onViewport={setViewport} refreshSignal={previewRefresh} versionKey={project?.version_count ?? 0} picker={picker} onElementSelect={onElementSelect} onResolveErrors={resolveRuntimeErrors} resolveDisabled={!!tracking || !!pendingPrompt} />
                <VisualEditToolbar element={selectedElement} onApply={applyVisualEdit} onClose={clearElement}
                  onAskAi={async (desc) => { if (await send(`On the selected element, ${desc}.`, "edit")) clearElement(); }} />
              </div>}
              {view === "dashboard" && <DashboardView project={project} liveUrl={liveUrl} onCenterView={setView} onOpenActivity={() => setActivityRequest((n) => n + 1)} onExportZip={() => downloadProjectZip(project, files)} />}
              {view === "code" && <CodeViewer file={file} onToggleFrozen={toggleFrozen} projectId={id} version={project.version_count} onSaved={async () => { await reload(); setPreviewRefresh((n) => n + 1); }} />}
              {view === "data" && <DataPane projectId={id} entities={entities} selectedEntity={selectedEntity} onSelectEntity={setSelectedEntity} onReload={reload} />}
              {view === "integrations" && <IntegrationsPane projectId={id} files={files} onOpenFile={openFile} />}
              {view === "secrets" && <SecretsPane projectId={id} />}
              {view === "github" && <GitHubPane github={github} versions={versions} onExport={exportToGitHub} onImport={importFromGitHub} />}
              {view === "logic" && <LogicPane projectId={id} files={files} onOpenFile={openFile} />}
              {view === "agents" && <AgentsPane projectId={id} projectSlug={project.slug} onOpenSecrets={() => setView("secrets")} agent={agent} files={files} onOpenFile={openFile} version={project.version_count} onReload={reload} />}
              {view === "settings" && <SettingsPane project={project} files={files} entities={entities} versions={versions} live={deploy.live} domains={domains} onCenterView={setView} onFixWithAI={prefillChat} onReload={reload} />}
              {view === "versions" && <div className="h-full overflow-hidden"><VersionsPane versions={versions} onRestore={restore} onPublish={publishVersion} publishing={publishingVersion} restoring={restoring} projectId={id} /></div>}
              {view === "app_users" && <AppUsersPane projectId={id} />}
              {view === "deploy" && <DeployPane projectId={id} versions={versions} deployments={deploy.deployments} deploy={deploy} domains={domains} loading={deploy.loading} working={deploy.working} onDeploy={deployNow} onPromote={promoteStaging} onRollback={rollbackTo} onCancel={deploy.cancel} onFixWithAI={prefillChat} />}
              {view === "launchpad" && <LaunchpadPane projectId={id} onCenterView={setView} />}
            </CenterCanvas>
            </div>
          </div>
        </main>

        {contextOpen && (
          <aside className="hidden lg:flex flex-col h-full w-[280px] xl:w-[300px] shrink-0 bg-background">
            <div className="w-full min-w-0 h-full">
              <ContextPanel
                project={project} files={files} entities={entities} selectedFile={selectedFile}
                onOpenFile={openFile} onSelectEntity={(n) => { setSelectedEntity(n); setView("data"); }}
                versions={versions} restoring={restoring} onRestore={restore}
                centerView={view} onCenterView={setView}
              />
            </div>
          </aside>
        )}
      </div>

      {publishOpen && (
        <PublishModal
          project={project} versions={versions} live={deploy.live} liveUrl={liveUrl}
          domains={domains} working={deploy.working} onDeploy={deployNow}
          onClose={() => setPublishOpen(false)} onView={setView}
        />
      )}
      {compareOpen && (
        <CompareLiveDialog
          projectId={id}
          liveVersion={versions.find((v) => v.number === deploy.live.production?.version_number) || null}
          latestVersion={versions[0] || null}
          onClose={() => setCompareOpen(false)}
        />
      )}
      <PlansModal open={plansOpen} onClose={() => setPlansOpen(false)} />
      <ActivityBar runs={runs} builds={builds} runtimeErrors={runtimeErrors} openRequest={activityRequest} projectId={id} />
    </div>
  );
}