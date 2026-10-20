import { useEffect, useState } from "react";

// Shared state for the Agent-mode left bar: the selected workspace agent and the open
// conversation. Lives at module level so the MAIN shell sidebar (which renders the agent nav +
// conversation list) and the /agent chat page stay in sync — one bar, like the reference surface.
const listeners = new Set();
let state = {
  agentName: "NexusAgent",
  activeId: null,
};

function setState(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export const getAgentChatState = () => state;
export const setAgentName = (agentName) => setState({ agentName, activeId: null });
export const setActiveId = (activeId) => { if (activeId !== state.activeId) setState({ activeId }); };

// "New conversation" sits at the TOP of the agent nav (reference order). The button is
// rendered by ShellSidebar; the creation + list-refresh logic stays in ConversationsSidebar.
// This one-shot emitter connects the two without duplicating the logic.
// Cross-surface "Send to chat": a page (e.g. the Workflows template gallery) parks a prompt
// here and navigates to /agent; the chat consumes and sends it once its conversation is ready.
let pendingSend = null;
export const setPendingChatSend = (text) => { pendingSend = text; };
export const consumePendingChatSend = () => { const t = pendingSend; pendingSend = null; return t; };

let newConversationListener = null;
export const onNewConversation = (fn) => { newConversationListener = fn; return () => { if (newConversationListener === fn) newConversationListener = null; }; };
export const requestNewConversation = () => { newConversationListener?.(); };

export function useAgentChatState() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((v) => v + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return state;
}