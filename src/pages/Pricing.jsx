import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Check, ArrowRight, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { Button } from "@/components/ui/button";
import { planCreditLines } from "@/lib/planCredits";

const fmtCents = (cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format((cents || 0) / 100);

export default function Pricing() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [authed, setAuthed] = useState(false);
  const [currentPlan, setCurrentPlan] = useState(null);
  const [billingInterval, setBillingInterval] = useState("monthly");

  useEffect(() => {
    base44.auth.isAuthenticated().then(setAuthed).catch(() => {});
    base44.functions.invoke("publicPlans", {})
      .then((res) => {
        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        const list = [...(data?.plans || [])].sort((a, b) => a.tier_rank - b.tier_rank);
        if (!list.length) throw new Error("No plans returned");
        setPlans(list);
      })
      .catch((e) => setError(e?.response?.data?.error || e?.message || "Could not load pricing"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    base44.auth.me().then((me) =>
      workspaceRead("own_workspaces").then((d) => {
        const ws = d.workspaces || [];
        if (ws[0]) return base44.functions.invoke("commerce", { action: "billing_overview", workspace_id: ws[0].id });
        return null;
      })
    ).then((res) => {
      if (res?.data?.entitlements?.plan_code) setCurrentPlan(res.data.entitlements.plan_code);
      else if (res?.data?.subscription?.plan_code) setCurrentPlan(res.data.subscription.plan_code);
    }).catch(() => {});
  }, [authed]);

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link to="/landing" className="flex items-center gap-2">
            <span className="h-7 w-7 rounded-lg bg-gradient-to-br from-brand to-brand/80 grid place-items-center shadow-sm">
              <Sparkles className="h-4 w-4 text-brand-foreground" />
            </span>
            <span className="font-semibold tracking-tight">NexusAI</span>
          </Link>
          <div className="flex items-center gap-2">
            {authed ? (
              <Button size="sm" asChild><Link to="/billing">Go to billing</Link></Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" asChild><Link to="/login">Sign in</Link></Button>
                <Button size="sm" asChild><Link to="/register">Get started</Link></Button>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Header */}
      <section className="max-w-6xl mx-auto px-6 py-16 sm:py-20 text-center">
        <h1 className="text-3xl sm:text-5xl font-bold tracking-tight">Simple, transparent pricing</h1>
        <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
          Start free. Upgrade when you need more. Credits are consumed only by successful AI operations.
        </p>
      </section>

      {/* Plans */}
      <section className="max-w-6xl mx-auto px-6 pb-16 sm:pb-20">
        {loading ? (
          <div className="flex justify-center py-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : error ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center text-[13.5px] text-muted-foreground">
            Pricing is temporarily unavailable. {error}
          </div>
        ) : (
          <>
          <div className="flex justify-center gap-1 p-1 mb-8 w-fit mx-auto rounded-lg border border-border bg-muted/40">
            {[["monthly", "Monthly"], ["yearly", "Yearly"]].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setBillingInterval(value)}
                className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${billingInterval === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {label}
                {value === "yearly" && <span className="ml-1.5 text-[10px] font-semibold text-emerald-600">Save 20%</span>}
              </button>
            ))}
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {plans.filter((p) => p.interval !== "one_time" && (p.price_cents === 0 || p.interval === billingInterval)).map((p, i) => {
              const featured = p.code === `pro_${billingInterval}` || (i === 1 && plans.length > 2);
              return (
                <div
                  key={p.code}
                  className={`relative rounded-xl border p-6 flex flex-col ${featured ? "border-brand ring-1 ring-brand/30 bg-brand-muted/20" : "border-border bg-card"}`}
                >
                  {featured && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand text-brand-foreground text-[10px] font-semibold uppercase px-3 py-0.5">
                      Popular
                    </span>
                  )}
                  <h3 className="font-semibold text-lg">{p.name}</h3>
                  <div className="mt-3 flex items-baseline gap-1">
                    <span className="text-3xl font-bold">{p.price_cents === 0 ? "Free" : fmtCents(p.price_cents, p.currency)}</span>
                    {p.price_cents > 0 && <span className="text-sm text-muted-foreground">{p.interval === "yearly" ? "/year" : "/mo"}</span>}
                  </div>
                  {p.price_cents > 0 && p.interval === "yearly" && (
                    <div className="text-[12px] text-muted-foreground">billed annually</div>
                  )}
                  {p.price_cents > 0 && p.interval === "monthly" && (
                    <div className="text-[12px] text-muted-foreground">billed monthly</div>
                  )}
                  <p className="mt-2 text-[13px] text-muted-foreground min-h-[40px]">{p.description}</p>
                  <div className="mt-4 space-y-2 text-[13px]">
                    {planCreditLines(p).map((line) => (
                      <Feature key={line} included>{line} / {p.interval === "one_time" ? "purchase" : "period"}</Feature>
                    ))}
                    <Feature included>{p.limits?.projects != null ? `${p.limits.projects} projects` : "Unlimited projects"}</Feature>
                    <Feature included>{p.limits?.seats != null ? `${p.limits.seats} ${p.limits.seats === 1 ? "seat" : "seats"}` : "Unlimited members"}</Feature>
                    {p.entitlements?.in_app_code_edits && <Feature included>In-app code edits</Feature>}
                    {p.entitlements?.ai_model_selection && <Feature included>AI model selection</Feature>}
                    {p.entitlements?.github_integration && <Feature included>GitHub integration</Feature>}
                    {p.entitlements?.early_beta_access && <Feature included>Early access to beta features</Feature>}
                    {p.entitlements?.referral_credits != null && <Feature included>{p.entitlements.referral_credits} credits to share with a friend</Feature>}
                    {p.entitlements?.free_domain_1yr && <Feature included>Free domain for 1 year</Feature>}
                    {p.entitlements?.premium_support && <Feature included>Premium support</Feature>}
                    {p.entitlements?.published_app_url && <Feature included>Free published app URL</Feature>}
                    {p.trial_days > 0 && <Feature included>{p.trial_days}-day trial</Feature>}
                    {p.entitlements?.sso && <Feature included>SSO & SCIM</Feature>}
                    {p.entitlements?.custom_domains > 0 && <Feature included>{p.entitlements.custom_domains} custom domain{p.entitlements.custom_domains > 1 ? "s" : ""}</Feature>}
                    {p.entitlements?.advanced_models && <Feature included>Advanced models</Feature>}
                  </div>
                  <Button
                    className="mt-6 w-full"
                    variant={featured ? "default" : "outline"}
                    asChild
                  >
                    <Link to={authed ? "/billing" : "/register"} className="flex items-center justify-center gap-1.5">
                      {currentPlan === p.code ? "Current plan" : !authed ? (p.price_cents === 0 ? "Get started" : "Start trial") : "Switch plan"} {currentPlan !== p.code && <ArrowRight className="h-3.5 w-3.5" />}
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
          </>
        )}

        {/* Enterprise */}
        <div className="mt-8 rounded-xl border border-border bg-gradient-to-br from-brand-muted/30 to-muted/20 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex-1">
            <h3 className="font-semibold">Enterprise</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">Custom Message and Integration credits, unlimited seats, SSO/SCIM, audit logs, DPA, and dedicated support.</p>
          </div>
          <Button className="bg-brand text-brand-foreground hover:bg-brand/90" asChild>
            <Link to="/register">Contact sales</Link>
          </Button>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-border bg-muted/30">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <h2 className="text-center text-2xl font-bold tracking-tight mb-8">Pricing FAQ</h2>
          <div className="space-y-6">
            <Faq q="What is a credit?" a="Credits are consumed by AI operations — building, editing, and agent runs. The cost depends on the model and token usage. You're never charged for failed operations." />
            <Faq q="Do credits expire?" a="Included plan credits reset each billing period. Purchased credits do not expire and carry over." />
            <Faq q="Can I buy more credits without upgrading?" a="Yes. You can purchase additional credits at any time, and they're added to your balance immediately." />
            <Faq q="What happens when I run out of credits?" a="On the free plan, operations are blocked. On paid plans, you can enable overage or auto-top-up to keep building without interruption." />
            <Faq q="Can I cancel anytime?" a="Yes. Cancellation takes effect at the end of your current billing period. You keep your purchased credits." />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-[13px] text-muted-foreground">
          <Link to="/landing" className="flex items-center gap-2">
            <span className="h-5 w-5 rounded bg-gradient-to-br from-brand to-brand/80 grid place-items-center">
              <Sparkles className="h-3 w-3 text-brand-foreground" />
            </span>
            <span>NexusAI</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/landing" className="hover:text-foreground transition-colors">Home</Link>
            <Link to="/login" className="hover:text-foreground transition-colors">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Feature({ children, included }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-4 w-4 rounded-full grid place-items-center shrink-0 ${included ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
        <Check className="h-2.5 w-2.5" />
      </span>
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}

function Faq({ q, a }) {
  return (
    <div>
      <h3 className="font-medium text-[15px]">{q}</h3>
      <p className="mt-1 text-[14px] text-muted-foreground leading-relaxed">{a}</p>
    </div>
  );
}