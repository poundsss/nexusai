import React, { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import useAttachments from "@/hooks/useAttachments";
import { createProjectWithScaffold } from "@/lib/createProject";
import ChatMessages from "@/components/growthagent/ChatMessages";
import GrowComposer from "@/components/growthagent/GrowComposer";
import GrowChatSurface from "@/components/growthagent/GrowChatSurface";
import ChatColumn from "@/components/composer/ChatColumn";
import GrowModulesGrid from "@/components/growthagent/GrowModulesGrid";
import GrowRequestDialog from "@/components/growthagent/GrowRequestDialog";
import GrowModuleDashboard from "@/components/growthagent/dashboard/GrowModuleDashboard";
import GrowProjectDashboard from "@/components/growthagent/dashboard/GrowProjectDashboard";
import { GROW_MODULES } from "@/components/growthagent/growModules";
import GrowProjectBar from "@/components/growthagent/GrowProjectBar";
import GrowCalendar from "@/components/growthagent/GrowCalendar";
import GrowQuestionnaire from "@/components/growthagent/GrowQuestionnaire";
import { parseQuestions } from "@/lib/growQuestions";
import { Dialog, DialogContent } from "@/components/ui/dialog";

const AGENT_NAME = "GrowthAgent";
const heldKey = (conversationId) => `grow-held-request:${conversationId}`;

// GROW — chat is the main workspace; the six Runable Grow modules sit ABOVE it in an adaptive
// grid (3 / 2 / 1 columns) with every subcategory visible at once. A subcategory opens its
// parameter form in place; completing it inserts the generated request into the Chat composer
// (manual Send only). The composer carries a compact `Choose project` selector with a `+`
// create action. The selected project and the conversation survive module switches.
export default function GrowthAgent() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [pick, setPick] = useState(null); // {module, sub} — open parameter dialog
  const [dashModuleId, setDashModuleId] = useState(null); // module whose dashboard is open
  const [injected, setInjected] = useState(null); // {token, text} — composer draft insertion
  const [projectError, setProjectError] = useState(null); // composer inline error
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const pendingRef = useRef(null);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [heldTick, setHeldTick] = useState(0); // bumps on every explicit project selection
  const selectProject = useCallback((id) => { setProjectId(id); setHeldTick((t) => t + 1); }, []);
  // The preserved ?tiktok return flow: TikTok publishing status opens the calendar in place.
  const [tiktokOpen, setTiktokOpen] = useState(() => new URLSearchParams(window.location.search).has("tiktok"));
  // The confirmed Runable Grow surface: the advertising-module grid above the chat composer
  // ONLY — no extra navigation tabs (none are verified in Runable's product). The preserved
  // ?tiktok return flow still opens the calendar dialog in place; the six read-only panels
  // stay preserved as reusable components with their certified backend contracts.
  const unsubRef = useRef(null);
  const chatScrollRef = useRef(null);
  const { workspace } = useWorkspace();
  const attachments = useAttachments();

  // Sidebar Dashboard navigation: ?dashboard=1 opens the project Dashboard — the certified
  // project-scoped `grow` rollup for the composer's selected project. Any navigation into the
  // Grow surface leaves a module dashboard; project, conversation and composer draft persist.
  const dashOpen = new URLSearchParams(location.search).has("dashboard");
  // Screenshot-matched Grow · Module Dashboard (five certified modules) — same route, no new path.
  const moduleDashOpen = new URLSearchParams(location.search).has("moduleDashboard");
  useEffect(() => { setDashModuleId(null); }, [location.key]);
  // Sidebar project links under Dashboard select the project via ?project=<id>.
  const urlProject = new URLSearchParams(location.search).get("project");
  useEffect(() => { if (urlProject) setProjectId(urlProject); }, [urlProject]);
  const backToChat = useCallback(() => navigate("/growth-agent", { replace: true }), [navigate]);

  const ensureSession = useCallback(async () => {
    const list = await base44.agents.listConversations({ agent_name: AGENT_NAME });
    if (list && list.length) {
      setActiveId(list[0].id);
    } else {
      const c = await base44.agents.createConversation({ agent_name: AGENT_NAME, metadata: { name: "Growth session", description: "Composed growth loop session" } });
      setActiveId(c.id);
    }
    setLoading(false);
  }, []);

  useEffect(() => { ensureSession(); }, [ensureSession]);

  // Keep the newest message in view: the chat scrolls to its bottom on every update.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    if (!activeId) { setMessages([]); return; }
    let alive = true;
    base44.agents.getConversation(activeId).then((c) => { if (alive) setMessages(c?.messages || []); });
    unsubRef.current = base44.agents.subscribeToConversation(activeId, (data) => setMessages(data?.messages || []));
    return () => { alive = false; if (unsubRef.current) unsubRef.current(); };
  }, [activeId]);

  // The workspace's projects for the composer selector (one page, newest first, read on the server).
  useEffect(() => {
    if (!workspace?.id) return;
    let alive = true;
    (async () => {
      try {
        const d = await workspaceRead("projects", { workspace_id: workspace.id, sort: "-created_date", limit: 50, exclude_status: "archived" });
        if (!alive) return;
        const items = d.projects || [];
        setProjects(items);
        if (items.length === 1) setProjectId(items[0].id);
      } catch { /* project-free chat stays available */ }
      if (alive) setProjectsLoaded(true);
    })();
    return () => { alive = false; };
  }, [workspace?.id]);

  // Live renames/archives elsewhere update the composer's project list immediately. Realtime
  // events are treated as untrusted pointers (direct Project reads are locked server-side):
  // each event only names the affected project, which is re-read through the authorized
  // surface and merged only if this member may see it.
  useEffect(() => base44.entities.Project.subscribe((ev) => {
    if (ev.type === "update") {
      workspaceRead("project", { project_id: ev.id })
        .then((d) => { if (d.project) setProjects((cur) => cur.map((p) => (p.id === ev.id ? d.project : p)).filter((p) => p.status !== "archived")); })
        .catch(() => {});
    }
    if (ev.type === "delete") setProjects((cur) => cur.filter((p) => p.id !== ev.id));
  }), []);

  const createProject = useCallback(async ({ name, description }) => {
    const p = await createProjectWithScaffold({ workspace, name, description });
    setProjects((cur) => [p, ...cur]);
    selectProject(p.id);
    return p;
  }, [workspace, selectProject]);

  const send = async (text, preferences = {}, requestId = null) => {
    if (!activeId || !text.trim() || sending) return;
    // Explicit selection with several projects: the request never ships without one — the agent
    // must never silently substitute another project. Project-free chat (no projects at all) stays open.
    if (projects.length > 0 && !projectId) {
      // A client-minted request id tags the eventual message so a reload can recognise it.
      pendingRef.current = { text, preferences, request_id: crypto.randomUUID() };
      // Reload-safe hold: only the request itself is stored — never a project selection.
      sessionStorage.setItem(heldKey(activeId), JSON.stringify(pendingRef.current));
      setProjectError("Select the project for this request in the composer — requests are never sent without one when projects exist.");
      return;
    }
    setProjectError(null);
    setSending(true);
    try {
      const conv = await base44.agents.getConversation(activeId);
      const urls = attachments.urls;
      const context = [];
      const selectedName = projects.find((p) => p.id === projectId)?.name;
      if (projectId) context.push({
        type: "project_context",
        message: "The member selected this project in the Grow composer. It is the ONLY project this request may act on: pass data.project_id verbatim as project_id on every project-scoped surface call (googleAds, managedAds, leadGen, listen, aeo, virality, seoScan, support, outreach, emailDomain, projectDomains, coldCalling, myBusiness). Never infer a project from the message text, never substitute another project's id, and refuse a project-scoped action that lacks this selection.",
        // project_name is a display-only label; binding and authorization use project_id alone.
        data: { project_id: projectId, ...(selectedName ? { project_name: selectedName } : {}) },
      });
      if (preferences.mode === "ask") context.push({ type: "response_mode", message: "Plan this growth request only. Do not execute any actions that create, update, delete, schedule, publish or spend.", data: { mode: "plan" } });
      if (preferences.designSystemId) context.push({ type: "design_preference", message: "Use this selected design language for creative recommendations in this request. This does not authorize changing the project's existing design.", data: { design_system_id: preferences.designSystemId } });
      // The canonical id also rides in the visible text: generated requests name the project by
      // its display name, and the model must never pass that name as project_id.
      if (requestId) context.push({ type: "client_request", message: "Client bookkeeping id for this request; ignore it.", data: { request_id: requestId } });
      // Display-only name label (never an identifier); skipped when the text already names it.
      const nameTag = selectedName && !text.includes(selectedName) ? `\n[project_name (display only): ${selectedName}]` : "";
      const content = projectId ? `${text.trim()}\n\n[project_id: ${projectId}]${nameTag}` : text.trim();
      await base44.agents.addMessage(conv, { role: "user", content, ...(urls.length ? { file_urls: urls } : {}), ...(preferences.modelId ? { model: preferences.modelId } : {}), ...(context.length ? { custom_context: context } : {}) });
      // Cleared only after a successful handoff of THIS request, so a failed or different
      // request never drops (or later re-sends) the held one.
      const held = pendingRef.current || JSON.parse(sessionStorage.getItem(heldKey(activeId)) || "null");
      // A restored draft clears on any successful send from the composer (it may have been edited).
      if (held && (held.draft || (requestId && held.request_id === requestId) || held.text.trim() === text.trim())) {
        pendingRef.current = null;
        sessionStorage.removeItem(heldKey(activeId));
      }
      if (urls.length) attachments.clear();
    } finally {
      setSending(false);
    }
  };

  // A request blocked only for a missing project continues once the member selects one.
  // After a reload, restore the held request for this conversation (still unsent, still held).
  useEffect(() => {
    if (!activeId || !projectsLoaded || pendingRef.current) return;
    const raw = sessionStorage.getItem(heldKey(activeId));
    if (!raw) return;
    const held = JSON.parse(raw);
    let alive = true;
    base44.agents.getConversation(activeId).then((c) => {
      if (!alive) return;
      // No server-side dedup exists: if the chat already holds this request as its latest user
      // message, the earlier send was accepted before storage cleared — never send it again.
      // Accepted only when a stored message carries this hold's request id — never by text.
      const accepted = held.request_id && (c?.messages || []).some((m) => m.role === "user"
        && (m.custom_context || []).some((x) => x?.type === "client_request" && x?.data?.request_id === held.request_id));
      if (accepted) { sessionStorage.removeItem(heldKey(activeId)); return; }
      if (held.draft) {
        setInjected({ token: Date.now(), text: held.text });
        setProjectError("Your unsent request was restored to the composer. Dismiss to discard it.");
      } else if (projects.length > 1) {
        pendingRef.current = held;
        setProjectError("Select a project to continue — your held request will send once you choose one.");
      } else {
        // Zero or one project now: never auto-send a stale request — return it to the composer,
        // kept saved as a draft until it is sent or explicitly discarded.
        sessionStorage.setItem(heldKey(activeId), JSON.stringify({ ...held, draft: true }));
        setInjected({ token: Date.now(), text: held.text });
        setProjectError("Your unsent request was restored to the composer. Dismiss to discard it.");
      }
    });
    return () => { alive = false; };
  }, [activeId, projectsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // A held request sends once per explicit selection (re-selecting the same project retries);
  // if another message is in flight, it waits and fires when sending ends.
  const firedTickRef = useRef(0);
  useEffect(() => {
    if (!heldTick || firedTickRef.current === heldTick) return;
    if (!projectId || !activeId || sending || !pendingRef.current) return;
    firedTickRef.current = heldTick;
    const held = pendingRef.current;
    pendingRef.current = null;
    send(held.text, held.preferences, held.request_id).catch(() => {
      pendingRef.current = held; // storage was not cleared
      setProjectError("Sending the held request failed. Select the project again to retry.");
    });
  }, [heldTick, projectId, activeId, sending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inline questionnaire: only the LATEST message, only when it is an assistant reply carrying
  // a grow-questions block; answering sends through the normal send() path (same project context).
  const [dismissedQ, setDismissedQ] = useState(null);
  const lastMsg = messages[messages.length - 1];
  const qKey = lastMsg?.id || messages.length;
  const questions = projectId && (heldTick > 0 || urlProject) && lastMsg?.role === "assistant" && !(lastMsg.tool_calls || []).some((t) => !t.results) ? parseQuestions(lastMsg.content) : null;

  return (
    <div className="h-full min-h-0 pt-1.5 sm:pt-2 pl-1.5 sm:pl-2 pr-1.5 sm:pr-2 bg-background">
      <div className="relative h-full min-h-0 rounded-xl overflow-hidden flex flex-col bg-gradient-to-b from-background to-muted/40">
        {/* RGB gradient strip — same accent as Home / Agent / the Builder's preview panel. */}
        <div className="h-[3px] shrink-0 w-full bg-gradient-to-r from-[#3B82F6] via-[#22d3ee] to-[#4FD1C5] bg-[length:200%_100%] animate-[gradient-pan_6s_linear_infinite]" />

        {dashModuleId ? (
          <GrowModuleDashboard
            module={GROW_MODULES.find((m) => m.id === dashModuleId)}
            workspace={workspace}
            projectId={projectId}
            onProjectChange={setProjectId}
            onBack={() => setDashModuleId(null)}
            onConfigure={(subId) => {
              const m = GROW_MODULES.find((x) => x.id === dashModuleId);
              const sub = m?.subs.find((s) => s.id === subId);
              if (m && sub) setPick({ module: m, sub });
            }}
          />
        ) : dashOpen ? (
          <GrowProjectDashboard
            workspace={workspace}
            projectId={projectId}
            onProjectChange={setProjectId}
            onBack={backToChat}
            onModuleDashboard={() => navigate("/growth-agent?moduleDashboard=1", { replace: false })}
            onConfigure={(subId) => {
              const m = GROW_MODULES.find((mm) => mm.subs.some((s) => s.id === subId));
              const sub = m?.subs.find((s) => s.id === subId);
              if (m && sub) setPick({ module: m, sub });
            }}
          />
        ) : moduleDashOpen ? (
          <GrowModuleDashboard
            module={null}
            workspace={workspace}
            projectId={projectId}
            onProjectChange={setProjectId}
            onBack={backToChat}
            onConfigure={(subId) => {
              const m = GROW_MODULES.find((mm) => mm.subs.some((s) => s.id === subId));
              const sub = m?.subs.find((s) => s.id === subId);
              if (m && sub) setPick({ module: m, sub });
            }}
          />
        ) : (
        <GrowChatSurface
          scrollRef={chatScrollRef}
          composer={
            <GrowComposer
              onSend={send}
              disabled={sending || !activeId}
              sending={sending}
              injected={injected}
              attachments={attachments}
              error={projectError}
              questionnaire={questions && dismissedQ !== qKey ? (
                <GrowQuestionnaire key={qKey} questions={questions} disabled={sending || !activeId} onDismiss={() => setDismissedQ(qKey)} onSubmit={(t) => send(t)} />
              ) : null}
              onDismissError={() => {
                setProjectError(null);
                // Dismissing the restored-draft notice is the explicit discard.
                const saved = activeId && JSON.parse(sessionStorage.getItem(heldKey(activeId)) || "null");
                if (saved?.draft) { sessionStorage.removeItem(heldKey(activeId)); setInjected({ token: Date.now(), text: "" }); }
              }}
              projectBar={
                <GrowProjectBar
                  projects={projects}
                  projectId={projectId}
                  onChange={selectProject}
                  onCreate={createProject}
                />
              }
            />
          }
        >
          <div className="mx-auto max-w-5xl pt-4">
            <GrowModulesGrid onPick={setPick} onOpenModule={(m) => setDashModuleId(m.id)} />
          </div>

          <ChatColumn className="pt-6">
            {loading && !activeId ? (
              <div className="py-16 grid place-items-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : messages.length === 0 || !(projectId && (heldTick > 0 || urlProject)) && !(projectsLoaded && projects.length === 0) ? (
              <div className="text-center py-12 sm:py-16">
                <h1 className="text-[1.75rem] sm:text-[2.25rem] font-semibold tracking-tight leading-tight">
                  What should we grow today?
                </h1>
                <p className="mt-3 text-[14.5px] text-muted-foreground max-w-lg mx-auto leading-relaxed">
                  Pick a module above or describe the goal — the Growth Agent composes the loop.
                </p>
              </div>
            ) : (
              <ChatMessages messages={messages} agentName={AGENT_NAME} workspaceId={workspace?.id || null} />
            )}
          </ChatColumn>
        </GrowChatSurface>
        )}
      </div>

      {/* Subcategory parameter form — generates the request and inserts it into the composer. */}
      <GrowRequestDialog
        pick={pick}
        projects={projects}
        projectId={projectId}
        onClose={() => setPick(null)}
        onGenerate={(text) => { setInjected({ token: Date.now(), text }); setPick(null); }}
      />

      {/* Preserved TikTok publish return flow (?tiktok) — the calendar opens in place. */}
      <Dialog open={tiktokOpen} onOpenChange={setTiktokOpen}>
        <DialogContent className="max-w-4xl p-0">
          <GrowCalendar workspace={workspace} />
        </DialogContent>
      </Dialog>
    </div>
  );
}