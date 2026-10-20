import React, { useState } from "react";
import { MessageSquare } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { setPendingChatSend } from "@/lib/agentChatStore";

// The "Suggested Workflows" browse dialog: category tabs across the top, template cards in a
// two-column grid. Each card hands its prompt to the Agent chat via the pending-send store —
// no workflow is created here, the agent sets it up through the existing surfaces.

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

const StripeIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="2" y="2" width="20" height="20" rx="4" fill="#635BFF" />
    <path d="M11.4 9.7c0-.6.6-.9 1.5-.9 1.3 0 3 .4 4.3 1.1V6.2c-1.4-.6-2.9-.8-4.3-.8-3.5 0-5.9 1.8-5.9 4.9 0 4.7 6.5 4 6.5 6 0 .7-.6 1-1.5 1-1.5 0-3.4-.6-4.9-1.5v3.8c1.6.7 3.3 1 4.9 1 3.6 0 6.1-1.8 6.1-4.9 0-5.1-6.6-4.2-6.7-6.1z" fill="#fff" />
  </svg>
);

const NotionIcon = () => (
  <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#37352f" />
    <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#37352f" fontFamily="Georgia, serif">N</text>
  </svg>
);

const PROVIDERS = {
  gmail: GmailIcon,
  gcal: GCalIcon,
  slack: SlackBrandIcon,
  github: GithubBrandIcon,
  jira: JiraIcon,
  stripe: StripeIcon,
  notion: NotionIcon,
};

const CATEGORIES = [
  {
    label: "Work productivity",
    templates: [
      { id: "morning_briefing", title: "Morning briefing", description: "Every morning, summarize your unread emails, today's meetings, and Slack threads into a digest", providers: ["gmail", "gcal", "slack"], prompt: "Set up a workflow: every morning, summarize my unread emails, today's meetings, and Slack threads into a digest." },
      { id: "pr_review_reminder", title: "PR review reminder", description: "When a PR assigned to you hasn't been reviewed after 2 hours, send a Slack reminder with a direct link", providers: ["github", "slack"], prompt: "Set up a workflow: when a PR assigned to me hasn't been reviewed after 2 hours, send a Slack reminder with a direct link." },
      { id: "new_ticket_alert", title: "New ticket alert", description: "When a Jira ticket is assigned to you, send a Slack message with the details and relevant context", providers: ["jira", "slack"], prompt: "Set up a workflow: when a Jira ticket is assigned to me, send a Slack message with the details and relevant context." },
      { id: "meeting_prep", title: "Meeting prep", description: "30 min before each meeting, pull the invite, find related emails and docs, and send a context summary", providers: ["gcal", "notion"], prompt: "Set up a workflow: 30 minutes before each meeting, pull the invite, find related emails and docs, and send me a context summary." },
      { id: "unanswered_email_nudge", title: "Unanswered email nudge", description: "When an email sits unread for 24 hours, send a reminder with a one-line summary of what it's about", providers: ["gmail"], prompt: "Set up a workflow: when an email sits unread for 24 hours, send me a reminder with a one-line summary of what it's about." },
      { id: "end_of_day_wrap_up", title: "End of day wrap-up", description: "Every evening, summarize what you got done today and draft a short to-do list for tomorrow", providers: [], prompt: "Set up a workflow: every evening, summarize what I got done today and draft a short to-do list for tomorrow." },
    ],
  },
  {
    label: "Business growth",
    templates: [
      { id: "lead_follow_up", title: "Lead follow-up", description: "After 48 hours without reply, send a follow-up email to new leads with a relevant case study", providers: ["gmail"], prompt: "Set up a workflow: after 48 hours without reply, send a follow-up email to new leads with a relevant case study." },
      { id: "pipeline_digest", title: "Pipeline digest", description: "Every Monday, summarize the sales pipeline and flag deals stuck for over a week", providers: ["slack"], prompt: "Set up a workflow: every Monday, summarize the sales pipeline and flag deals stuck for over a week." },
      { id: "churn_risk_alert", title: "Churn risk alert", description: "When a customer hasn't logged in for 14 days, ping the success team in Slack to reach out", providers: ["slack"], prompt: "Set up a workflow: when a customer hasn't logged in for 14 days, ping the success team in Slack to reach out." },
      { id: "competitor_watch", title: "Competitor watch", description: "Watch competitor sites and notify you when they ship new features or change pricing", providers: [], prompt: "Set up a workflow: watch competitor sites and notify me when they ship new features or change pricing." },
      { id: "customer_feedback_digest", title: "Customer feedback digest", description: "Every Monday, summarize last week's customer feedback from support tickets and reviews", providers: [], prompt: "Set up a workflow: every Monday, summarize last week's customer feedback from support tickets and reviews." },
      { id: "new_signup_welcome", title: "New signup welcome", description: "When a new user signs up, send a personalized welcome email with onboarding tips", providers: ["gmail"], prompt: "Set up a workflow: when a new user signs up, send a personalized welcome email with onboarding tips." },
    ],
  },
  {
    label: "Money handling",
    templates: [
      { id: "weekly_expense_report", title: "Weekly expense report", description: "Every Friday, compile receipts from your inbox into a summary and email it to finance", providers: ["gmail"], prompt: "Set up a workflow: every Friday, compile receipts from my inbox into a summary and email it to finance." },
      { id: "new_payment_alert", title: "New payment alert", description: "Notify the team in Slack whenever a new Stripe payment over $1000 is processed", providers: ["stripe", "slack"], prompt: "Set up a workflow: notify the team in Slack whenever a new Stripe payment over $1000 is processed." },
      { id: "subscription_watch", title: "Subscription watch", description: "Scan your inbox monthly for recurring charges and flag any subscriptions you may not be using", providers: ["gmail"], prompt: "Set up a workflow: scan my inbox monthly for recurring charges and flag any subscriptions I may not be using." },
      { id: "invoice_reminder", title: "Invoice reminder", description: "When an invoice has been unpaid for 7 days, send a polite payment reminder to the client", providers: ["gmail"], prompt: "Set up a workflow: when an invoice has been unpaid for 7 days, send a polite payment reminder to the client." },
      { id: "budget_check", title: "Budget check", description: "Every Friday, compare this week's spending to the monthly budget and email a summary", providers: ["gmail"], prompt: "Set up a workflow: every Friday, compare this week's spending to the monthly budget and email me a summary." },
      { id: "low_balance_warning", title: "Low balance warning", description: "Send a Slack alert when any tracked account balance drops below $1000", providers: ["slack"], prompt: "Set up a workflow: send a Slack alert when any tracked account balance drops below $1000." },
    ],
  },
  {
    label: "Home organizer",
    templates: [
      { id: "grocery_reminder", title: "Grocery reminder", description: "Every Sunday evening, remind you of items running low and draft a shopping list for the week", providers: [], prompt: "Set up a workflow: every Sunday evening, remind me of items running low and draft a shopping list for the week." },
      { id: "bill_due_alert", title: "Bill due alert", description: "3 days before any bill is due, send a reminder with the amount and a link to pay", providers: ["gmail"], prompt: "Set up a workflow: 3 days before any bill is due, send me a reminder with the amount and a link to pay." },
      { id: "trash_day_reminder", title: "Trash day reminder", description: "Every Sunday evening, remind you which bins to take out for the morning pickup", providers: [], prompt: "Set up a workflow: every Sunday evening, remind me which bins to take out for the morning pickup." },
      { id: "package_arrival_watch", title: "Package arrival watch", description: "When a tracking number marks a package as delivered, notify you immediately", providers: ["gmail"], prompt: "Set up a workflow: when a tracking number marks a package as delivered, notify me immediately." },
      { id: "weekly_meal_plan", title: "Weekly meal plan", description: "Every Saturday morning, draft a meal plan for the week and a matching grocery list", providers: [], prompt: "Set up a workflow: every Saturday morning, draft a meal plan for the week and a matching grocery list." },
      { id: "cleaning_schedule", title: "Cleaning schedule", description: "Send a daily reminder of one rotating cleaning task to keep up with house chores", providers: [], prompt: "Set up a workflow: send me a daily reminder of one rotating cleaning task to keep up with house chores." },
    ],
  },
  {
    label: "Education",
    templates: [
      { id: "study_session_reminder", title: "Study session reminder", description: "Block focus time on your calendar each weekday and remind you 10 minutes before it starts", providers: ["gcal"], prompt: "Set up a workflow: block focus time on my calendar each weekday and remind me 10 minutes before it starts." },
      { id: "reading_list_digest", title: "Reading list digest", description: "Every Saturday, summarize the articles you saved this week and pick the top three to read", providers: [], prompt: "Set up a workflow: every Saturday, summarize the articles I saved this week and pick the top three to read." },
      { id: "flashcard_prompt", title: "Flashcard prompt", description: "Every weekday morning, send three flashcard questions from your active study deck", providers: [], prompt: "Set up a workflow: every weekday morning, send me three flashcard questions from my active study deck." },
      { id: "vocabulary_of_the_day", title: "Vocabulary of the day", description: "Every weekday at 9am, send a new vocabulary word with example sentences and pronunciation", providers: [], prompt: "Set up a workflow: every weekday at 9am, send me a new vocabulary word with example sentences and pronunciation." },
      { id: "note_summary", title: "Note summary", description: "After each study session, summarize your notes into a concise review document", providers: [], prompt: "Set up a workflow: after each study session, summarize my notes into a concise review document." },
      { id: "weekly_review_quiz", title: "Weekly review quiz", description: "Every Sunday, generate a short quiz covering what you studied this week", providers: [], prompt: "Set up a workflow: every Sunday, generate a short quiz covering what I studied this week." },
    ],
  },
  {
    label: "Wellness",
    templates: [
      { id: "hydration_reminder", title: "Hydration reminder", description: "Send a gentle reminder every two hours during the workday to drink a glass of water", providers: [], prompt: "Set up a workflow: send me a gentle reminder every two hours during the workday to drink a glass of water." },
      { id: "movement_break", title: "Movement break", description: "Every 90 minutes, suggest a short stretch or walk to break up long stretches at the desk", providers: [], prompt: "Set up a workflow: every 90 minutes, suggest a short stretch or walk to break up long stretches at the desk." },
      { id: "bedtime_wind_down", title: "Bedtime wind-down", description: "30 minutes before bedtime, send a calming routine reminder to help you unwind", providers: [], prompt: "Set up a workflow: 30 minutes before bedtime, send me a calming routine reminder to help me unwind." },
      { id: "mood_check_in", title: "Mood check-in", description: "Twice a day, send a quick mood check-in prompt and log your responses", providers: [], prompt: "Set up a workflow: twice a day, send me a quick mood check-in prompt and log my responses." },
      { id: "workout_reminder", title: "Workout reminder", description: "Send a daily reminder for your scheduled workout with a link to today's plan", providers: ["gcal"], prompt: "Set up a workflow: send me a daily reminder for my scheduled workout with a link to today's plan." },
      { id: "meditation_prompt", title: "Meditation prompt", description: "Every morning, suggest a 10-minute guided meditation matched to how you're feeling", providers: [], prompt: "Set up a workflow: every morning, suggest a 10-minute guided meditation matched to how I'm feeling." },
    ],
  },
];

function TemplateCard({ t, onSend }) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="text-[15px] font-semibold tracking-tight">{t.title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t.description}</p>
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <div className="flex items-center gap-1.5">
          {t.providers.map((p) => {
            const Icon = PROVIDERS[p];
            if (!Icon) return null;
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

export default function SuggestedWorkflowsDialog({ open, onOpenChange, onSend }) {
  const [tab, setTab] = useState(0);
  const category = CATEGORIES[tab];

  const send = (prompt) => {
    onOpenChange(false);
    onSend(prompt);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0">
        {/* Header band: title + subtitle, with the dialog's own close control */}
        <div className="border-b border-border px-6 py-5 pr-14">
          <h2 className="text-[19px] font-semibold tracking-tight">Suggested Workflows</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Discover workflows your agent can do for you</p>
        </div>

        {/* Category tabs */}
        <div className="border-b border-border px-6 py-4">
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background p-1.5">
            {CATEGORIES.map((c, i) => (
              <button
                key={c.label}
                type="button"
                onClick={() => setTab(i)}
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${i === tab ? "bg-secondary text-foreground" : "text-foreground/80 hover:bg-accent"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Template grid for the active category */}
        <div className="max-h-[60vh] overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {category.templates.map((t) => <TemplateCard key={t.id} t={t} onSend={send} />)}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}