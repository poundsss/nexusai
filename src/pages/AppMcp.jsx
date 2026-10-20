import React, { useMemo } from "react";
import { Server, Copy, KeyRound, ShieldCheck, EyeOff, Wrench, Ban, Info } from "lucide-react";
import AccountPage from "@/components/shell/AccountPage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";

// App MCP server — read-only inspect surface.
//
// The app's MCP server is configured via base44/mcp/config.json and served at /api/mcp on the
// app's own published domain; the platform generates one tool per exposed entity operation /
// function / agent from that file. There is NO backend function that returns an "MCP server
// status / endpoint / key" payload for the app's own server — the config file is the source of
// truth, edited at build time, and the exact URL is shown on the platform's MCP page after
// publishing. So this surface only documents the known, static config facts and resolves the
// endpoint from the published origin at runtime. No key generation (OAuth uses consent; Public is
// anonymous), no exposure-rule invention, no new MCP semantics.
//
// Build-time snapshot of base44/mcp/config.json (kept here as a frontend copy because the config
// is not exposed over HTTP). Update this snapshot when the config file changes.
const MCP_CONFIG = {
  auth: "oauth",
  login_path: "/login",
  consent_path: "/oauth/consent",
  tools: {
    entity_overrides: {
      AIRun: { operations: [] }, AppEntity: { operations: [] }, AppRecord: { operations: [] },
      AuditLog: { operations: [] }, Build: { operations: [] }, Conversation: { operations: [] },
      CreditTransaction: { operations: [] }, FunctionInvocation: { operations: [] },
      MCPConnection: { operations: [] }, MCPInvocation: { operations: [] }, Message: { operations: [] },
      Project: { operations: [] }, ProjectFile: { operations: [] }, ProjectSecret: { operations: [] },
      ProjectVersion: { operations: [] }, UsageEvent: { operations: [] }, User: { operations: [] },
      Workspace: { operations: [] }, WorkspaceSecret: { operations: [] },
    },
  },
};
const AUTH_LABEL = { oauth: "Sign in required · OAuth", none: "Public" };

export default function AppMcp() {
  const { loading } = useWorkspace();
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-app.base44.app";
  const endpoint = useMemo(() => new URL("/api/mcp", origin).toString(), [origin]);

  const overrides = MCP_CONFIG.tools?.entity_overrides || {};
  const excludedAgents = MCP_CONFIG.tools?.excluded_agents || [];
  const functions = MCP_CONFIG.tools?.functions || [];
  const optedOutEntities = Object.entries(overrides).filter(([, v]) => Array.isArray(v.operations) && v.operations.length === 0).map(([k]) => k);
  const narrowedEntities = Object.entries(overrides).filter(([, v]) => Array.isArray(v.operations) && v.operations.length > 0 && v.operations.length < 4);

  const copy = (text) => { navigator.clipboard?.writeText(text); toast({ title: "Copied" }); };

  return (
    <AccountPage loading={loading} title="App MCP server" subtitle="Expose this app to AI clients over MCP at /api/mcp on the published domain.">
      <section className="rounded-lg border border-border p-5">
        <div className="flex items-start gap-3">
          <span className="h-10 w-10 rounded-lg grid place-items-center shrink-0 bg-muted text-muted-foreground"><Server className="h-5 w-5" /></span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">Server endpoint</h3>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                <ShieldCheck className="h-3 w-3" />Configured
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {AUTH_LABEL[MCP_CONFIG.auth] || MCP_CONFIG.auth || "oauth"}
              </span>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              The server activates when the app is published. The exact URL is shown on the app's MCP page after publishing — connect AI clients (Claude, ChatGPT, Cursor) to it there.
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <code className="flex-1 min-w-0 truncate font-mono text-[12.5px]">{endpoint}</code>
              <button onClick={() => copy(endpoint)} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Copy"><Copy className="h-3.5 w-3.5" /></button>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
              <span>login: <code className="font-mono">{MCP_CONFIG.login_path || "/login"}</code></span>
              <span>consent: <code className="font-mono">{MCP_CONFIG.consent_path || "/oauth/consent"}</code></span>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2">
        <KeyRound className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
        <p className="text-[12px] text-muted-foreground">
          <span className="font-medium text-amber-700">No API key.</span> OAuth servers authenticate through the consent flow; Public servers are anonymous. Key generation does not apply, and none is invented here.
        </p>
      </div>

      <section className="mt-4 rounded-lg border border-border p-5">
        <h3 className="text-sm font-semibold mb-3">Exposed surface</h3>
        <p className="text-[12.5px] text-muted-foreground mb-3">
          Exposure is opt-out: every entity and in-app agent is exposed automatically. These are the current deviations recorded in the config (build-time snapshot).
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="rounded-md border border-border p-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold"><EyeOff className="h-3.5 w-3.5 text-muted-foreground" />Opted-out entities</div>
            <div className="mt-1.5 text-[12px] text-muted-foreground">
              {optedOutEntities.length === 0 ? <span className="text-muted-foreground/60">None — all entities exposed.</span> : <ul className="space-y-0.5 max-h-40 overflow-y-auto">{optedOutEntities.map((e) => <li key={e} className="font-mono">{e}</li>)}</ul>}
            </div>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold"><Wrench className="h-3.5 w-3.5 text-muted-foreground" />Narrowed entities</div>
            <div className="mt-1.5 text-[12px] text-muted-foreground">
              {narrowedEntities.length === 0 ? <span className="text-muted-foreground/60">None narrowed.</span> : <ul className="space-y-0.5">{narrowedEntities.map(([e, v]) => <li key={e} className="font-mono">{e} <span className="text-muted-foreground/70">→ {v.operations.join("/")}</span></li>)}</ul>}
            </div>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold"><Ban className="h-3.5 w-3.5 text-muted-foreground" />Excluded agents</div>
            <div className="mt-1.5 text-[12px] text-muted-foreground">
              {excludedAgents.length === 0 ? <span className="text-muted-foreground/60">None — all agents exposed.</span> : <ul className="space-y-0.5">{excludedAgents.map((a) => <li key={a} className="font-mono">{a}</li>)}</ul>}
            </div>
          </div>
        </div>

        {functions.length > 0 && (
          <div className="mt-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-1.5"><Wrench className="h-3.5 w-3.5 text-muted-foreground" />Custom function tools</div>
            <ul className="divide-y divide-border/40 rounded-md border border-border">
              {functions.map((f) => (
                <li key={f.name} className="px-2.5 py-1.5 flex items-center gap-2 text-[12px]">
                  <code className="font-mono">invoke_{f.name}</code>
                  <span className="text-muted-foreground truncate">{f.title}</span>
                  {f.disabled && <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">disabled</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="mt-3 flex items-start gap-2 text-[11.5px] text-muted-foreground/80">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <p>Configuration changes require editing <code className="font-mono">base44/mcp/config.json</code> and republishing. There is no runtime backend function to mutate or enumerate the MCP server config; the file is the source of truth and this view is a build-time snapshot of it.</p>
      </div>
    </AccountPage>
  );
}