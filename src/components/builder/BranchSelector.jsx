import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Hexagon, Loader2, Plus } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// The branch panel behind the "Main" pill: the active working line on top, every other
// branch a click away, and creation of a new branch that snapshots the current working
// files server-side. Staging and production stay reachable at the bottom.
export default function BranchSelector({ project, envs, liveUrls, onMain, onSwitched, onActivity }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  useEffect(() => {
    if (!open || branches || !project?.id) return;
    setLoading(true);
    base44.functions.invoke("branches", { project_id: project.id, action: "list" })
      .then((res) => setBranches(res.data?.branches || []))
      .catch((e) => toast({ variant: "destructive", title: "Branches could not load", description: e.response?.data?.error || e.message }))
      .finally(() => setLoading(false));
  }, [open, branches, project?.id]);

  const call = async (payload, title) => {
    setWorking(true);
    try {
      const res = await base44.functions.invoke("branches", { project_id: project?.id, ...payload });
      toast({ title, description: `${res.data?.files ?? 0} file(s) on this branch now.` });
      setBranches(null);
      setName("");
      setCreating(false);
      await onSwitched?.();
      setOpen(false);
    } catch (e) {
      toast({ variant: "destructive", title: "Branch action failed", description: e.response?.data?.error || e.message });
    } finally { setWorking(false); }
  };

  const rows = branches || [];
  const active = rows.find((b) => b.is_active) || null;
  const others = rows.filter((b) => !b.is_active);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Branches"
        title="Branches and environments"
        className="flex items-center gap-1 h-7 rounded-md bg-muted px-2 text-[12px] font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
      >
        Main
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-40 w-[320px] rounded-lg border border-border bg-popover shadow-md overflow-hidden">
          {/* Panel header */}
          <div className="flex items-center gap-1.5 h-9 px-3 border-b border-border">
            <span className="text-[12.5px] font-semibold">Main</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </div>

          {/* Active branch */}
          <div className="px-3 pt-3">
            <div className="flex items-center rounded-lg bg-muted px-3 py-2.5">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
              <span className="text-[12.5px] font-medium truncate">{active ? (active.is_default ? "Main chat" : active.name) : "Main chat"}</span>
              <Hexagon className="ml-auto h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </div>
          </div>

          {/* Other branches — one click switches the working line */}
          {others.map((b) => (
            <button
              key={b.id}
              onClick={() => call({ action: "switch", branch_id: b.id }, "Switched to " + b.name)}
              disabled={working}
              className="mx-3 mt-1 flex w-[calc(100%-24px)] items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted disabled:opacity-50 transition-colors"
            >
              <span className="text-[12.5px] truncate">{b.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">{b.files_count} files</span>
            </button>
          ))}

          {/* Empty state + creation */}
          <div className="px-4 py-4 text-center">
            {others.length === 0 && !loading && (
              <>
                <p className="text-[13.5px] font-semibold">Create your first branch</p>
                <p className="mt-1 text-[12px] text-muted-foreground">Build, test, and experiment before merging changes into main.</p>
              </>
            )}
            {!creating ? (
              <button
                onClick={() => setCreating(true)}
                disabled={working}
                className="mt-4 w-full flex items-center justify-center gap-1.5 rounded-lg bg-foreground text-background px-3 py-2.5 text-[12.5px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <Plus className="h-4 w-4" />Create new branch
              </button>
            ) : (
              <form
                className="mt-4 flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) call({ action: "create", name: name.trim() }, "Branch created");
                }}
              >
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Branch name"
                  aria-label="Branch name"
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 ring-ring"
                />
                <button
                  type="submit"
                  disabled={!name.trim() || working}
                  className="grid place-items-center rounded-md bg-foreground text-background px-2.5 py-1.5 text-[12px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
                </button>
              </form>
            )}
          </div>

          {/* Environments */}
          <div className="border-t border-border px-3 py-1.5">
            {["staging", "production"].map((env) => {
              const url = liveUrls?.[env] || null;
              const version = envs?.[env] ?? null;
              return (
                <a
                  key={env}
                  href={url || "#"}
                  target={url ? "_blank" : undefined}
                  rel="noreferrer"
                  onClick={(e) => { if (!url) e.preventDefault(); }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors"
                >
                  <span className="capitalize text-foreground">{env}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                    {version != null ? "v" + version : "not deployed"}
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}