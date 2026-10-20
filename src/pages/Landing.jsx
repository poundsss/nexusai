import React, { useState } from "react";
import { Link } from "react-router-dom";
import HeroComposer from "@/components/landing/HeroComposer";
import { Sparkles, ArrowRight, Zap, Shield, GitBranch, Globe, Cpu, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";

const FEATURES = [
  { icon: Zap, title: "AI-Powered Building", description: "Describe what you want in plain English. The AI scaffolds, builds, and iterates — files, data, and deployments." },
  { icon: GitBranch, title: "Version Control", description: "Every change is an immutable version. Restore any snapshot, export to GitHub, or import from a commit." },
  { icon: Globe, title: "One-Click Deploy", description: "Staging and production pipelines with immutable artifacts. Promotion ships exactly what staging verified." },
  { icon: Shield, title: "Enterprise Security", description: "SSO, SCIM, audit logs, and row-level security. Secrets encrypted at rest, never exposed to the client." },
  { icon: Cpu, title: "Model Routing", description: "Choose your model or let the router pick the most cost-effective one. Credits are debited only on success." },
  { icon: Layers, title: "Marketplace", description: "Browse templates, integrations, and agents from the community. Install with explicit capability consent." },
];

const IDEAS = [
  "CRM with a deal pipeline",
  "Internal admin tool",
  "Marketplace with checkout",
  "Analytics dashboard",
  "Booking app with a calendar",
];

export default function Landing() {
  const [prompt, setPrompt] = useState("");
  return (
    <div className="min-h-screen bg-background">
      {/* Light hero: nav sits inside it, same soft-white surface as the app screens */}
      <section className="relative overflow-hidden bg-gradient-to-b from-background to-muted/40 text-foreground">
        <div className="absolute inset-0 bg-[radial-gradient(65%_75%_at_50%_0%,hsl(var(--brand)/0.12),transparent_70%)]" />

        <nav className="relative max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-7 w-7 rounded-lg bg-primary grid place-items-center">
              <Sparkles className="h-4 w-4 text-primary-foreground" />
            </span>
            <span className="font-semibold tracking-tight">NexusAI</span>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/pricing" className="hidden sm:block text-[13.5px] text-muted-foreground hover:text-foreground transition-colors">Pricing</Link>
            <Link to="/login" className="text-[13.5px] text-muted-foreground hover:text-foreground transition-colors">Sign in</Link>
            <Button size="sm" asChild>
              <Link to="/register">Get started</Link>
            </Button>
          </div>
        </nav>

        <div className="relative max-w-3xl mx-auto px-6 pt-16 pb-20 sm:pt-24 sm:pb-28 text-center">
          <h1 className="text-[2.5rem] sm:text-[3.5rem] font-semibold tracking-tight leading-[1.03]">
            Have an idea. Wake up to a<br />business ready for customers.
          </h1>
          <p className="mt-5 text-[16px] text-muted-foreground max-w-lg mx-auto leading-relaxed">
            NexusAI turns a sentence into a working application — code, data model, preview and deployment included.
          </p>

          {/* Prompt-shaped CTA — the hero action mirrors the product's composer */}
          <HeroComposer prompt={prompt} onPromptChange={setPrompt} />

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {IDEAS.map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => setPrompt(idea)}
                className="rounded-full border border-border bg-card px-3.5 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              >
                {idea}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 py-16 sm:py-24">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-[2rem] font-semibold tracking-tight">Everything you need to ship</h2>
          <p className="mt-2.5 text-muted-foreground">A complete platform — not just a code generator.</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="rounded-xl border border-border bg-card p-5 hover:border-foreground/25 transition-colors">
                <span className="grid place-items-center h-9 w-9 rounded-lg bg-muted text-foreground">
                  <Icon className="h-4 w-4" />
                </span>
                <h3 className="mt-4 text-[14.5px] font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">{f.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 py-16 sm:py-20 text-center">
          <h2 className="text-2xl sm:text-[2rem] font-semibold tracking-tight">Ready to build?</h2>
          <p className="mt-2.5 text-muted-foreground">Start with free credits. No credit card required.</p>
          <Button size="lg" className="mt-7" asChild>
            <Link to="/register" className="flex items-center gap-1.5">
              Create your first app <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-[13px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="h-5 w-5 rounded bg-foreground grid place-items-center">
              <Sparkles className="h-3 w-3 text-background" />
            </span>
            <span>NexusAI</span>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
            <Link to="/login" className="hover:text-foreground transition-colors">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}