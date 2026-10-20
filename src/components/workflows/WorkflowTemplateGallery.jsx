import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquare, Sparkles } from "lucide-react";
import { setPendingChatSend } from "@/lib/agentChatStore";
import SuggestedWorkflowsDialog from "@/components/workflows/SuggestedWorkflowsDialog";

// Workflow template gallery — the empty-state starter shown when a surface has no workflows
// yet. Each card hands its prompt to the Agent chat ("Send to chat"); no workflow is created
// here — the agent sets it up through the existing surfaces.

const GmailIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="2" y="4" width="20" height="16" rx="2" fill="#fff" stroke="#dadce0" />
    <rect x="2" y="4" width="4.5" height="16" fill="#4285F4" />
    <rect x="17.5" y="4" width="4.5" height="16" fill="#34A853" />
    <path d="M2 5.5 12 13 22 5.5" fill="none" stroke="#EA4335" strokeWidth="2.4" strokeLinejoin="round" />
  </svg>
);

const GCalIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#dadce0" />
    <path d="M21 10V6a3 3 0 0 0-3-3h-4v7z" fill="#4285F4" />
    <path d="M3 14v4a3 3 0 0 0 3 3h4v-7z" fill="#4285F4" opacity="0.85" />
    <text x="12" y="16.2" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#4285F4" fontFamily="Arial, sans-serif">31</text>
  </svg>
);

const SlackBrandIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#36C5F0" d="M9.5 2.5a2 2 0 0 0 0 4h2v-2a2 2 0 0 0-2-2zM9.5 7.5H4.5a2 2 0 1 0 0 4h5a2 2 0 0 0 0-4z" />
    <path fill="#2EB67D" d="M21.5 9.5a2 2 0 0 0-4 0v2h2a2 2 0 0 0 2-2zM16.5 9.5v-5a2 2 0 1 0-4 0v5a2 2 0 0 0 4 0z" />
    <path fill="#ECB22E" d="M14.5 21.5a2 2 0 0 0 0-4h-2v2a2 2 0 0 0 2 2zM14.5 16.5h5a2 2 0 1 0 0-4h-5a2 2 0 0 0 0 4z" />
    <path fill="#E01E5A" d="M2.5 14.5a2 2 0 0 0 4 0v-2h-2a2 2 0 0 0-2 2zM7.5 14.5v5a2 2 0 1 0 4 0v-5a2 2 0 0 0-4 0z" />
  </svg>
);

const GithubBrandIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#181717" d="M12 1.5A10.5 10.5 0 0 0 8.7 22c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.2-3.5-1.2-.5-1.2-1.2-1.6-1.2-1.6-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.3-.3-4.8-1.2-4.8-5.1 0-1.1.4-2 1-2.7-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.8 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.7 5.1.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5z" />
  </svg>
);

const JiraIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <path fill="#2684FF" d="M12 2l5.5 5.5a1.6 1.6 0 0 1 0 2.3L12 15.3 6.5 9.8a1.6 1.6 0 0 1 0-2.3z" />
    <path fill="#2684FF" opacity="0.75" d="M12 11.5l4 4a1.6 1.6 0 0 1 0 2.3L12 21.8l-4-4a1.6 1.6 0 0 1 0-2.3z" />
  </svg>
);

const PROVIDERS = {
  gmail: GmailIcon,
  gcal: GCalIcon,
  slack: SlackBrandIcon,
  github: GithubBrandIcon,
  jira: JiraIcon,
};

const TEMPLATES = [
  {
    id: "morning_briefing",
    title: "Morning briefing",
    description: "Every morning, summarize my unread emails, today's meetings, and Slack threads into a digest",
    providers: ["gmail", "gcal", "slack"],
    prompt: "Set up a workflow: every morning, summarize my unread emails, today's meetings, and Slack threads into a digest.",
  },
  {
    id: "pr_review_reminder",
    title: "PR review reminder",
    description: "When a PR assigned to me hasn't been reviewed after 2 hours, send a Slack reminder with a direct link",
    providers: ["github", "slack"],
    prompt: "Set up a workflow: when a PR assigned to me hasn't been reviewed after 2 hours, send a Slack reminder with a direct link.",
  },
  {
    id: "new_ticket_alert",
    title: "New ticket alert",
    description: "When a Jira ticket is assigned to me, send a Slack message with the details and relevant context",
    providers: ["jira", "slack"],
    prompt: "Set up a workflow: when a Jira ticket is assigned to me, send a Slack message with the details and relevant context.",
  },
];

function TemplateCard({ t, onSend }) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5 text-center shadow-sm">
      <h3 className="text-[15px] font-semibold tracking-tight">{t.title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t.description}</p>
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <div className="flex items-center gap-1.5">
          {t.providers.map((p) => {
            const Icon = PROVIDERS[p];
            return (
              <span key={p} className="grid h-[26px] w-[26px] place-items-center rounded-md border border-border bg-white p-[3px] shadow-sm">
                <Icon />
              </span>
            );
          })}
        </div>
        <button
          onClick={() => onSend(t.prompt)}
          className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-accent"
        >
          <MessageSquare className="h-3.5 w-3.5" />Send to chat
        </button>
      </div>
    </div>
  );
}

// The gallery: heading, the three starter templates, and "Browse more workflows" — the
// Suggested Workflows dialog with category tabs across six collections of templates.
export default function WorkflowTemplateGallery() {
  const navigate = useNavigate();
  const [browseOpen, setBrowseOpen] = useState(false);

  const sendToChat = (prompt) => {
    setPendingChatSend(prompt);
    navigate("/agent");
  };

  return (
    <div className="py-6 text-center">
      <h2 className="text-[19px] font-semibold tracking-tight">Set up a workflow. Let Nexus handle it.</h2>
      <p className="mt-1.5 text-[13px] text-muted-foreground">Workflows run automatically in the background on a schedule or triggered by your apps</p>

      <div className="mx-auto mt-6 flex max-w-[420px] flex-col gap-4">
        {TEMPLATES.map((t) => <TemplateCard key={t.id} t={t} onSend={sendToChat} />)}
      </div>

      <button
        onClick={() => setBrowseOpen(true)}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
      >
        <Sparkles className="h-4 w-4" />Browse more workflows
      </button>

      <SuggestedWorkflowsDialog open={browseOpen} onOpenChange={setBrowseOpen} onSend={sendToChat} />
    </div>
  );
}