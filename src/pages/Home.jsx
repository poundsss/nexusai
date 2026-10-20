import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import { ArrowRight, Rocket, Sparkles, ChevronsUpDown } from "lucide-react";
import Composer from "@/components/home/Composer";
import PoolCreditsLine from "@/components/shell/PoolCreditsLine";
import { useBuilderCredits } from "@/hooks/useBuilderCredits";
import { createProjectWithScaffold, nameFromDescription } from "@/lib/createProject";
import { formatDistanceToNow } from "date-fns";
import HomeFooter from "@/components/home/HomeFooter";

// Top-right navigation mapped to NexusAI's real routes (not Bolt's marketing pages).
const TOP_LINKS = [
  { label: "Templates", to: "/marketplace" },
  { label: "Pricing", to: "/pricing" },
  { label: "Help", to: "/help" },
];

// Home is a creation surface, not a dashboard: a dark, blue-lit canvas owns the first
// viewport (Bolt-style), with the composer as the dominant element and the app gallery
// ("Recently viewed") below. The whole page is an explicit dark surface so it matches the
// reference regardless of the global light/dark theme.
export default function Home() {
  const { user, workspace, loading } = useWorkspace();
  const credits = useBuilderCredits();
  const [projects, setProjects] = useState(null);
  const navigate = useNavigate();
  // The landing hero's intent (prompt + Build/Ask mode) survives registration through the
  // safe returnTo and is consumed exactly once here, then stripped from the URL.
  const [intent] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const prompt = (params.get("prompt") || "").trim();
      const mode = params.get("mode") === "ask" ? "ask" : "build";
      if (!prompt) return null;
      window.history.replaceState({}, "", window.location.pathname);
      return { prompt, mode };
    } catch { return null; }
  });
  const intentStarted = useRef(false);

  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 8 }).then((d) => setProjects(d.projects || []));
  }, [workspace]);

  // Reference images travel with the description to the Builder's first AI run, so an app created
  // from an image is generated against that image rather than from the text alone.
  const create = async (description, { mode = "build", imageUrls = [], modelId = null, designSystemId = null } = {}) => {
    const project = await createProjectWithScaffold({ workspace, user, name: nameFromDescription(description), description });
    // A design system chosen in the hero composer is applied to the NEW project through the
    // authorized builder-settings surface — the same server-side persistence the Builder uses.
    if (designSystemId) {
      await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: project.id, design_system_id: designSystemId });
    }
    const images = imageUrls.length ? `&images=${encodeURIComponent(JSON.stringify(imageUrls))}` : "";
    // A model chosen for the first prompt travels to the Builder and its first AI run.
    const model = modelId ? `&model=${encodeURIComponent(modelId)}` : "";
    // "Ask" (discuss before building) is preserved for the FIRST run; "build" stays the
    // Builder's default, so the URL carries it only when it differs.
    const runMode = mode === "ask" ? "&mode=discuss" : "";
    navigate(`/projects/${project.id}?prompt=${encodeURIComponent(description)}${images}${model}${runMode}`);
  };

  // The hero's intent drives the FIRST post-registration create — once, when the workspace
  // the new user's scaffold lands in is ready.
  useEffect(() => {
    if (!workspace || !intent || intentStarted.current) return;
    intentStarted.current = true;
    create(intent.prompt, { mode: intent.mode });
  }, [workspace, intent]);

  return (
    // Split-screen shell: a neutral outer surface (the workspace) wraps a single floating
    // "screen" — the Builder's central-panel pattern — which carries the blue-lit canvas,
    // a top gradient strip, and a subtle ring so it reads as its own surface.
    <div className="h-full min-h-0 pt-1.5 sm:pt-2 pl-1.5 sm:pl-2 bg-background">
      <div className="relative h-full min-h-0 rounded-xl overflow-hidden flex flex-col bg-gradient-to-b from-background to-muted/40">
        {/* RGB gradient strip — same accent as the Builder's preview panel. */}
        <div className="relative z-[1] h-[3px] shrink-0 w-full bg-gradient-to-r from-[#3B82F6] via-[#22d3ee] to-[#4FD1C5] bg-[length:200%_100%] animate-[gradient-pan_6s_linear_infinite]" />

        {/* Top navigation — right-aligned links + promo chip, over the blue-lit canvas */}
        <header className="relative z-10 flex items-center gap-2.5 px-6 sm:px-10 h-14 shrink-0">
          <Link to="/" aria-label="Home" className="italic font-bold text-[16px] tracking-tight text-foreground hover:opacity-80 transition-opacity shrink-0">
            nexus.
          </Link>
          <span className="text-muted-foreground/50 text-[12.5px] select-none" aria-hidden>/</span>
          <div className="flex-1" />
          <Link
            to="/agent"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-accent transition-colors shadow-sm"
          >
            <Sparkles className="h-3.5 w-3.5 text-[#60a5fa]" />Introducing Agent mode
          </Link>
          {TOP_LINKS.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className="hidden sm:inline-flex items-center text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {l.label}
            </Link>
          ))}
          {/* Workspace pill — our functions, Bolt-style account chip */}
          <Link
            to="/settings"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card pl-1.5 pr-2 py-1 hover:bg-accent transition-colors shadow-sm"
            title={workspace?.name || "Workspace"}
          >
            <span className="h-6 w-6 rounded-full bg-gradient-to-br from-[#60a5fa] to-[#1d4ed8] text-white grid place-items-center text-[11px] font-semibold">
              {(user?.full_name || user?.email || "U").charAt(0).toUpperCase()}
            </span>
            <span className="hidden sm:block max-w-[8rem] truncate text-[12.5px] font-medium text-foreground">{user?.full_name || "Account"}</span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{credits?.plan || "Free"}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Link>
        </header>

        {/* Scrollable creation surface — the "screen" owns its own scroll. */}
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
          {/* Hero creation zone — fills the first viewport so the Recently viewed heading
              sits at the bottom fold, exactly like the reference. */}
          <section className="relative z-[1] flex flex-col justify-center px-6 sm:px-10 pt-10 sm:pt-16 pb-6 min-h-[calc(100vh-3.5rem-3.5rem)]">
            <div className="relative max-w-4xl mx-auto text-center">
              <h1 className="text-[2.25rem] sm:text-[3.25rem] font-semibold tracking-tight leading-[1.05]">
                What will you build today?
              </h1>
              <p className="mt-4 text-[15px] text-muted-foreground max-w-lg mx-auto leading-relaxed">
                Create stunning apps & websites by chatting with AI. NexusAI builds the pages, data and logic — with a live preview.
              </p>
              <div className="mt-9 text-left max-w-3xl mx-auto">
                <Composer onCreate={create} disabled={!workspace} models={credits.models} selectionAllowed={credits.modelSelection?.allowed !== false} initialText={intent?.prompt || ""} initialMode={intent?.mode || "build"} />
              </div>
            </div>
          </section>

          {/* Recently viewed — dark cards on the same canvas */}
          <section className="relative max-w-6xl mx-auto px-6 sm:px-10 pb-16 pt-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-semibold tracking-tight text-foreground">Recently viewed</h2>
              <Link to="/projects" className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground transition-colors">
                View all <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {loading || !projects ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {[0, 1, 2, 3].map((i) => <div key={i} className="h-32 bg-muted animate-pulse rounded-xl" />)}
              </div>
            ) : projects.length === 0 ? (
              <p className="mt-5 text-[13px] text-muted-foreground">Nothing built yet — your apps will appear here.</p>
            ) : (
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {projects.map((p) => (
                  <Link
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="group rounded-xl border border-border bg-card p-4 shadow-sm hover:bg-accent/40 transition-all"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="grid place-items-center h-8 w-8 rounded-lg bg-muted text-foreground text-[12px] font-semibold shrink-0">
                        {(p.name || "?").charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 text-[13.5px] font-medium truncate text-foreground">{p.name}</span>
                      {p.production_deployment_id && (
                        <span className="flex items-center gap-1 text-[10.5px] font-semibold uppercase text-emerald-400 shrink-0">
                          <Rocket className="h-3 w-3" />Live
                        </span>
                      )}
                    </div>
                    <p className="mt-2.5 text-[12.5px] text-muted-foreground line-clamp-2 min-h-[2.4em]">{p.description || "No description"}</p>
                    <div className="mt-3 flex items-center gap-3 pt-2.5 text-[11px] text-muted-foreground">
                      <span className="font-mono">v{p.version_count || 0}</span>
                      <span className="ml-auto">
                        {p.updated_date ? formatDistanceToNow(new Date(p.updated_date), { addSuffix: true }) : "—"}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {workspace && <div className="mt-8"><PoolCreditsLine /></div>}
          </section>

          <HomeFooter />
        </div>
      </div>
    </div>
  );
}