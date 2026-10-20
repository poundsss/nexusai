import React from "react";
import { LifeBuoy, BookOpen, MessageSquare, Mail, ExternalLink, Github, FileQuestion, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import AccountPage from "@/components/shell/AccountPage";

const RESOURCES = [
  { icon: BookOpen, title: "Documentation", description: "Guides on building, deploying, and managing your apps.", href: "#", external: true },
  { icon: MessageSquare, title: "Community", description: "Join the community to share and learn from others.", href: "#", external: true },
  { icon: Github, title: "GitHub Issues", description: "Report bugs or request features on our public repo.", href: "#", external: true },
  { icon: Zap, title: "Quick Start", description: "New here? Follow the quick start guide to build your first app.", to: "/projects" },
];

const FAQ = [
  { q: "How do I create my first project?", a: "Go to Projects, click New project, describe what you want in plain English, and the AI scaffolds, builds, and deploys it." },
  { q: "How do credits work?", a: "Credits are consumed by AI operations (building, editing, agent runs). Your workspace starts with free credits and you can purchase more or upgrade your plan." },
  { q: "Can I use my own GitHub?", a: "Yes — each user connects their own GitHub account. Exports create real commits; imports are validated before creating an internal version." },
  { q: "How do deployments work?", a: "Deploying is always explicit. Staging and production are independent pipelines. Promotion ships the exact artifact staging already verified — no rebuild." },
  { q: "Is my data secure?", a: "Secrets are stored server-side and never shown again. SSO/SCIM, audit logs, and row-level security keep your workspace isolated." },
];

export default function Help() {
  return (
    <AccountPage title="Help & Support" subtitle="Find answers, explore resources, and get unstuck.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-10">
        {RESOURCES.map((r) => {
          const Icon = r.icon;
          const inner = (
            <div className="group rounded-xl border border-border bg-card p-5 h-full hover:border-primary/30 hover:shadow-sm transition-all">
              <span className="h-10 w-10 rounded-lg bg-accent grid place-items-center text-accent-foreground">
                <Icon className="h-5 w-5" />
              </span>
              <h3 className="mt-3 font-medium text-[14px]">{r.title}</h3>
              <p className="mt-1 text-[12px] text-muted-foreground leading-relaxed">{r.description}</p>
              {r.external && <span className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground group-hover:text-foreground transition-colors">Learn more <ExternalLink className="h-3 w-3" /></span>}
            </div>
          );
          return r.to ? <Link key={r.title} to={r.to}>{inner}</Link> : <a key={r.title} href={r.href} target="_blank" rel="noreferrer">{inner}</a>;
        })}
      </div>

      <div className="rounded-xl border border-border bg-card p-6 mb-10">
        <div className="flex items-center gap-2 mb-4">
          <FileQuestion className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-[15px] font-semibold">Frequently asked questions</h2>
        </div>
        <div className="divide-y divide-border">
          {FAQ.map((f) => (
            <div key={f.q} className="py-4">
              <h3 className="text-[13px] font-medium">{f.q}</h3>
              <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <span className="h-12 w-12 rounded-xl bg-primary text-primary-foreground grid place-items-center shrink-0">
          <LifeBuoy className="h-6 w-6" />
        </span>
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold">Still need help?</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Contact our support team and we'll get back to you as soon as possible.</p>
        </div>
        <Button asChild>
          <a href="mailto:support@nexusai.com" className="flex items-center gap-1.5">
            <Mail className="h-4 w-4" /> Contact support
          </a>
        </Button>
      </div>
    </AccountPage>
  );
}