import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, PanelRight, Target, StickyNote, LayoutGrid, Wrench, X } from "lucide-react";
import AgentOnboarding from "@/components/agent/AgentOnboarding";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import useAttachments from "@/hooks/useAttachments";
import { AGENT_TERMINAL } from "@/hooks/useAgentRun";
import ChatMessages from "@/components/growthagent/ChatMessages";
import Composer from "@/components/growthagent/Composer";
import ChatColumn from "@/components/composer/ChatColumn";
import { useAgentChatState, setActiveId as setChatActiveId, setAgentName as setChatAgentName, consumePendingChatSend } from "@/lib/agentChatStore";
import AgentActivityPanel from "@/components/agent/AgentActivityPanel";

// First-touch quick actions (the empty-chat suggestion chips), in reference order.
const SUGGESTIONS = ["Check my calendar today", "Clear out my unread emails", "Draft my project to-do list"];

// AGENT — the personal-assistant mode. Same dark floating "screen" shell as the Apps / Grow
// surfaces. P0 parity surface: conversation sidebar (rename/archive, Active/Archived),
// agent switcher, the activity panel (All Agents + goal starter + recent runs), attachments,
// dictation, and inline transmission errors. The sidebar owns conversation selection; the
// latest session is restored (or the first one created) on first visit.
export default function Agent() {
  // The selected agent + open conversation live in the shared agent chat store: the MAIN shell
  // sidebar renders the agent nav and the conversation list; this page renders the chat surface.
  const chat = useAgentChatState();
  const agentName = chat.agentName;
  const activeId = chat.activeId;
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const attachments = useAttachments();
  const unsubRef = useRef(null);
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [activeRuns, setActiveRuns] = useState(0);
  const [onboardingOpen, setOnboardingOpen] = useState(() => { try { return localStorage.getItem("nexus_agent_onboarding") !== "done"; } catch { return true; } });
  const [chipsHidden, setChipsHidden] = useState(false);

  // Live count of the workspace's active goal runs (certified AgentRun rows, mirrored read-only)
  // — the badge on the activity toggle, so a running goal is visible without opening the panel.
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    const load = async () => {
      const rs = (await base44.entities.AgentRun.filter({ workspace_id: workspace.id }, { sort: "-created_date", limit: 20 }).catch(() => ({ items: [] }))).items;
      if (alive) setActiveRuns((rs || []).filter((r) => !AGENT_TERMINAL.includes(r.status)).length);
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [workspace]);

  // "/" composer shortcuts — every command opens an EXISTING certified surface. Goal opens the
  // goal starter (AgentGoalForm → the certified agentRun contract); the rest navigate to the
  // app's own pages. The composer itself executes nothing new.
  const commands = [
    { label: "Goal", hint: "Start a goal on an app", icon: Target, run: () => setActivityOpen(true) },
    { label: "Notes", hint: "Open notes", icon: StickyNote, run: () => navigate("/notes") },
    { label: "Apps", hint: "Open all apps", icon: LayoutGrid, run: () => navigate("/projects") },
    { label: "Connectors", hint: "Open connectors", icon: Wrench, run: () => navigate("/connections") },
  ];

  // Switching agents starts a fresh conversation scope (the sidebar re-selects/creates one).
  useEffect(() => { setChatActiveId(null); setMessages([]); }, [agentName]);

  useEffect(() => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    if (!activeId) { setMessages([]); return; }
    let alive = true;
    base44.agents.getConversation(activeId).then((c) => { if (alive) setMessages(c?.messages || []); });
    unsubRef.current = base44.agents.subscribeToConversation(activeId, (data) => setMessages(data?.messages || []));
    return () => { alive = false; if (unsubRef.current) unsubRef.current(); };
  }, [activeId]);

  // The certified send contract: addMessage { role:'user', content } (+ the documented
  // file_urls attachment field). Failures surface inline, never as a lost message.
  const send = async (text) => {
    if (!activeId || !text.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const conv = await base44.agents.getConversation(activeId);
      const urls = attachments.urls;
      await base44.agents.addMessage(conv, { role: "user", content: text.trim(), ...(urls.length ? { file_urls: urls } : {}) });
      if (urls.length) attachments.clear();
    } catch (e) {
      setSendError(e?.response?.data?.error || e?.response?.data?.message || e?.message || "Message failed to send");
    } finally {
      setSending(false);
    }
  };

  // "Send to chat" hand-off from other surfaces (Workflows template gallery): the prompt was
  // parked before navigating here; it fires once, when this page's conversation is ready.
  useEffect(() => {
    if (!activeId) return;
    const pending = consumePendingChatSend();
    if (pending) send(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  return (
    <div className="h-full min-h-0 pt-1.5 sm:pt-2 pl-1.5 sm:pl-2 pr-1.5 sm:pr-2 bg-background">
      <div className="relative h-full min-h-0 rounded-xl overflow-hidden flex flex-col bg-gradient-to-b from-background to-muted/40">
        {/* RGB gradient strip — same accent as Home / Grow / the Builder's preview panel. */}
        <div className="h-[3px] shrink-0 w-full bg-gradient-to-r from-[#3B82F6] via-[#22d3ee] to-[#4FD1C5] bg-[length:200%_100%] animate-[gradient-pan_6s_linear_infinite]" />

        {/* Onboarding REPLACES the chat: the chat only appears after the user picks a channel. */}
        {onboardingOpen ? (
          <AgentOnboarding
            agentName={agentName}
            onDone={() => { try { localStorage.setItem("nexus_agent_onboarding", "done"); } catch { /* unavailable */ } setOnboardingOpen(false); }}
          />
        ) : (
        <div className="flex-1 min-h-0 flex">
          {/* Main column — the conversation list lives in the MAIN shell sidebar (Agent mode) */}
          <div className="relative flex-1 min-w-0 flex flex-col">
            {/* No top bar — only the activity-panel toggle, floating at the top-right corner. */}
            <button
              onClick={() => setActivityOpen((v) => !v)}
              aria-label={activityOpen ? "Hide activity" : "Show activity"}
              title={activeRuns > 0 ? `${activeRuns} active goal run${activeRuns > 1 ? "s" : ""}` : undefined}
              className={`absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground ${activityOpen ? "bg-accent text-foreground" : ""}`}
            >
              <PanelRight className="h-4 w-4" />
              {activeRuns > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#60a5fa]" aria-hidden />}
            </button>

            {/* Chat area — centered column, hidden scrollbar. */}
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 sm:px-6">
              {activeId === null ? (
                <div className="h-full grid place-items-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ChatColumn className="pt-8 pb-10">
                  {messages.length === 0 ? (
                    <div className="text-center py-24 sm:py-32">
                      <h1 className="text-[2rem] sm:text-[2.75rem] font-semibold tracking-tight leading-tight">
                        Hey, nice to meet you. I'm {agentName}, your assistant.
                      </h1>
                      <p className="mt-4 text-[15px] text-muted-foreground max-w-lg mx-auto leading-relaxed">
                        What should we take off your plate first?
                      </p>
                    </div>
                  ) : (
                    <ChatMessages messages={messages} agentName={agentName} workspaceId={workspace?.id || null} />
                  )}
                </ChatColumn>
              )}
            </div>

            {/* Composer — pinned to the bottom, centered; attachments + dictation + errors. */}
            <div className="shrink-0 px-4 sm:px-6 pt-3 pb-4">
              {messages.length === 0 && !chipsHidden && (
                <div className="flex flex-wrap items-center justify-center gap-2 pb-3">
                  {SUGGESTIONS.map((label) => (
                    <button key={label} type="button" onClick={() => send(label)} className="rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                      {label}
                    </button>
                  ))}
                  <button type="button" onClick={() => setChipsHidden(true)} aria-label="Hide suggestions" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              <Composer
                onSend={send}
                disabled={sending || !activeId}
                placeholder="Message your assistant…"
                attachments={attachments}
                dictation
                error={sendError}
                onDismissError={() => setSendError(null)}
                commands={commands}
              />
            </div>
          </div>

          {/* Activity panel — side column on desktop, full-screen overlay on mobile */}
          {activityOpen && (
            <AgentActivityPanel onClose={() => setActivityOpen(false)} />
          )}
        </div>
        )}
      </div>
    </div>
  );
}