import React from "react";
import { Cloud, MonitorPlay, Users, Github, Loader2, LogOut, ArrowRight } from "lucide-react";

// Editor-style code card shown in place of the hero photo.
const HERO_CODE = [
  ["const", " branch ", "=", " useWorkspace", "({"],
  ["  repo", ": ", '"owner/app"', ","],
  ["  branch", ": ", '"feat/live-preview"', ","],
  ["});", "", "", ""],
  ["await", " nexus", ".commit", "({", ""],
  ["  files", ": [", '"src/app.tsx"', "],", ""],
  ["  message", ": ", '"ship it"', ""],
  ["});", "", "", ""],
];

const CODE_BACKDROP = [
  "const text = await translate(s",
  "  setCaptions((prev) => [...prev.s",
  "]);",
  "return () => tracker.dispose();",
  "}, [lang]);",
  "return (",
  "  <div className",
  "    <video",
  "      <source",
  "      onCha",
  "      <track",
  "      <id",
  "  </div>",
  "</div>",
];

const CAPABILITIES = [
  { icon: Cloud, title: "Cloud environment", text: "Nexus Code learns your codebase and sets up an environment your whole team can use." },
  { icon: MonitorPlay, title: "Live previews", text: "See changes as you build, with a live preview for every branch." },
  { icon: Users, title: "Build together", text: "Product, Design, QA, Marketing and Engineering can work directly on the product." },
];

// Dedicated Nexus Code product entry screen: shown before any workspace exists.
// Disconnected: the CTA starts the per-user GitHub OAuth. Connected: the CTA
// continues into the existing repository-selection flow, the connected @login is
// shown, and the account can be disconnected (returning to the disconnected state).
export default function EntryScreen({ connected, account, onConnect, onDisconnect, disconnecting, busy, error }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        {/* Page header */}
        <h1 className="text-3xl font-semibold tracking-tight">Nexus Code</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          View your repos, connect new ones and collaborate with your team
        </p>

        {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}

        {/* Hero card */}
        <div className="relative mt-6 overflow-hidden rounded-xl border border-border bg-card">
          {/* Faint source code backdrop */}
          <pre
            aria-hidden
            className="pointer-events-none absolute -right-2 top-4 hidden select-none text-right font-mono text-[11px] leading-[1.7] text-muted-foreground/25 md:block"
          >
            {CODE_BACKDROP.join("\n")}
          </pre>

          <div className="relative grid gap-6 md:grid-cols-[1.9fr_1fr]">
            {/* Content side */}
            <div className="p-7 sm:p-9">
              <div className="inline-flex items-center gap-2.5">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-muted">
                  <Github className="h-3.5 w-3.5 text-foreground" />
                </span>
                <span className="h-px w-4 bg-border" />
                <span className="text-[15px] font-bold tracking-tight">nexus<span className="text-brand">.</span> /</span>
              </div>

              <h2 className="mt-7 text-2xl sm:text-[27px] font-semibold tracking-tight leading-snug">
                Your codebase, ready to build.
              </h2>
              <p className="mt-3 max-w-sm text-[13px] leading-5 text-muted-foreground">
                Nexus Code sets up a cloud development environment for your existing codebase,
                with live previews and a place for your whole team to build together.
              </p>

              {connected ? (
                <div className="mt-7 flex flex-wrap items-center gap-3">
                  <button
                    onClick={onConnect}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-md bg-foreground text-background px-4 py-2 text-[13px] font-semibold hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    Continue to repositories
                  </button>
                  <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5">
                    <Github className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[12px]">{account?.login ? `@${account.login}` : "GitHub connected"}</span>
                    <button
                      onClick={onDisconnect}
                      disabled={disconnecting}
                      className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={onConnect}
                  disabled={busy}
                  className="mt-7 inline-flex items-center gap-2 rounded-md bg-foreground text-background px-4 py-2 text-[13px] font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
                  Connect GitHub
                </button>
              )}
              {!connected && (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Authorization is strictly per user — your token is never stored in project data.
                </p>
              )}
            </div>

            {/* Code panel side */}
            <div className="relative hidden items-center p-6 md:flex">
              <div className="w-full overflow-hidden rounded-lg border border-border bg-muted/60 shadow-sm">
                <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
                  <span className="h-2 w-2 rounded-full bg-red-400/70" />
                  <span className="h-2 w-2 rounded-full bg-amber-400/70" />
                  <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">app.tsx</span>
                </div>
                <pre className="px-3 py-3 font-mono text-[10.5px] leading-[1.75]">
                  {HERO_CODE.map((cells, i) => (
                    <div key={i}>
                      <span className="mr-3 inline-block w-3 select-none text-right text-muted-foreground/50">{i + 1}</span>
                      {cells.filter(Boolean).map((tok, j) => (
                        <span
                          key={j}
                          className={
                            ["const", "await", "})."].includes(tok.trim())
                              ? "text-brand"
                              : tok.trim().startsWith('"')
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-foreground"
                          }
                        >
                          {tok}
                        </span>
                      ))}
                    </div>
                  ))}
                </pre>
              </div>
            </div>
          </div>
        </div>

        {/* Capability highlights */}
        <div className="mt-10 grid gap-8 sm:grid-cols-3 text-left">
          {CAPABILITIES.map((c) => (
            <p key={c.title} className="text-[13px] leading-5 text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 align-middle font-semibold text-foreground">
                <c.icon className="h-3.5 w-3.5" />
                {c.title}
              </span>{" "}
              {c.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}