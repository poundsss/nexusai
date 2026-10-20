import React, { useCallback, useEffect, useState } from "react";
import { Loader2, ListChecks, Copy, Send, CheckCircle2, XCircle, RotateCcw, Wand2, Plus, ChevronRight, ChevronDown, ChevronUp } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

const PRIORITY_LABELS = { must_have: "Must have", medium: "Medium", nice_to_have: "Nice to have" };
const PRIORITY_TONES = {
  must_have: "bg-destructive/10 text-destructive",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  nice_to_have: "bg-muted text-muted-foreground",
};

const sendPromptOf = (item) =>
  `Help me execute this marketing action: "${item.title}".${item.body ? ` Details: ${item.body}` : ""} Propose concrete steps and, where it helps, implement them in my app. Keep everything else unchanged.`;

export default function ActionPlan({ projectId, onFixWithAI }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [busyKey, setBusyKey] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await base44.functions.invoke("actionPlan", { action: "list", project_id: projectId });
      setItems(res.data?.items || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (item, status) => {
    const key = `${item.item_id}:${status}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      const res = await base44.functions.invoke("actionPlan", { action: "update_item", project_id: projectId, item_id: item.item_id, status });
      setItems((prev) => prev.map((i) => (i.item_id !== item.item_id ? i : res.data.item)));
      toast({ title: status === "done" ? "Marked as done" : status === "dismissed" ? "Dismissed" : "Reopened" });
    } catch (e) {
      toast({ variant: "destructive", title: "Update failed", description: e.response?.data?.error || e.message });
    } finally {
      setBusyKey(null);
    }
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Your browser blocked clipboard access." });
    }
  };

  const itemText = (item) => `${item.title}\n${item.body || ""}`.trim();

  const generatePosts = async (item, mode) => {
    const key = `${item.item_id}:${mode}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      const res = await base44.functions.invoke("actionPlan", {
        action: mode, project_id: projectId, item_id: item.item_id,
      });
      setItems((prev) => prev.map((i) => (i.item_id !== item.item_id ? i : res.data.item)));
      toast({ title: mode === "generate_more" ? "More posts added" : "Posts generated", description: "10 integration credits charged." });
    } catch (e) {
      toast({ variant: "destructive", title: "Generation failed", description: e.response?.data?.error || e.message });
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ListChecks className="h-3.5 w-3.5" />Action plan
        </div>
        <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ListChecks className="h-3.5 w-3.5" />Action plan
        </div>
        <div className="flex items-start gap-2 p-3 text-[12px] text-destructive"><AlertGlyph />{error}</div>
      </div>
    );
  }
  if (!items.length) return null;

  const open = items.filter((i) => i.status === "open");
  const done = items.filter((i) => i.status === "done");
  const dismissed = items.filter((i) => i.status === "dismissed");
  const byPriority = { must_have: 0, medium: 1, nice_to_have: 2 };
  const sorted = [...open].sort((a, b) => (byPriority[a.priority] ?? 3) - (byPriority[b.priority] ?? 3) || (a.order || 0) - (b.order || 0));

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ListChecks className="h-3.5 w-3.5" />Action plan
        </h3>
        <span className="text-[11px] text-muted-foreground/60">{open.length} open · {done.length} done · {dismissed.length} dismissed</span>
      </div>

      <div className="p-3 space-y-2">
        {sorted.map((item) => (
          <ActionItemRow key={item.item_id} item={item} openId={openId} setOpenId={setOpenId} busyKey={busyKey}
            setStatus={setStatus} copyText={copyText} itemText={itemText} generatePosts={generatePosts} onFixWithAI={onFixWithAI} />
        ))}

        {done.length > 0 && (
          <ArchivedGroup label="Done" count={done.length} open={showDone} onToggle={() => setShowDone((v) => !v)} icon={CheckCircle2} tone="text-emerald-600 dark:text-emerald-400">
            {done.map((item) => (
              <ArchivedRow key={item.item_id} item={item} onReopen={() => setStatus(item, "open")} busyKey={busyKey} />
            ))}
          </ArchivedGroup>
        )}
        {dismissed.length > 0 && (
          <ArchivedGroup label="Dismissed" count={dismissed.length} open={showDismissed} onToggle={() => setShowDismissed((v) => !v)} icon={XCircle} tone="text-muted-foreground">
            {dismissed.map((item) => (
              <ArchivedRow key={item.item_id} item={item} onReopen={() => setStatus(item, "open")} busyKey={busyKey} />
            ))}
          </ArchivedGroup>
        )}
        <p className="text-[10.5px] text-muted-foreground/60">Generate posts / Generate more: 10 integration credits each. Send to Builder pre-fills a chat draft — you send it.</p>
      </div>
    </div>
  );
}

const AlertGlyph = () => <span className="mt-0.5 shrink-0">!</span>;

function ActionItemRow({ item, openId, setOpenId, busyKey, setStatus, copyText, itemText, generatePosts, onFixWithAI }) {
  const expanded = openId === item.item_id;
  const busy = busyKey !== null;
  const thisBusy = (k) => busyKey === `${item.item_id}:${k}`;

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        <button onClick={() => setOpenId(expanded ? null : item.item_id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
          {item.priority && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${PRIORITY_TONES[item.priority] || "bg-muted text-muted-foreground"}`}>
              {PRIORITY_LABELS[item.priority] || item.priority}
            </span>
          )}
        </button>
        <button onClick={() => copyText(itemText(item))} title="Copy" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
          <Copy className="h-3.5 w-3.5" />
        </button>
        {onFixWithAI && (
          <button onClick={() => onFixWithAI(sendPromptOf(item))} title="Send to Builder" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={() => setStatus(item, "done")} disabled={busy} title="Mark done" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-40 transition-colors">
          <CheckCircle2 className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => setStatus(item, "dismissed")} disabled={busy} title="Dismiss" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 transition-colors">
          <XCircle className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-2.5 space-y-2">
          {item.body && <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted-foreground">{item.body}</p>}

          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={() => generatePosts(item, "generate_posts")} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-2.5 py-1 text-[11.5px] font-semibold disabled:opacity-40 hover:opacity-90 transition-opacity">
              {thisBusy("generate_posts") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
              Generate posts
            </button>
            {item.posts.length > 0 && (
              <button onClick={() => generatePosts(item, "generate_more")} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40 hover:bg-accent/60 transition-colors">
                {thisBusy("generate_more") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                Generate more
              </button>
            )}
          </div>

          {item.posts.length > 0 && (
            <div className="divide-y divide-border rounded-md border border-border">
              {item.posts.map((p, i) => (
                <div key={i} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">{p.platform}</span>
                    <button onClick={() => copyText(p.copy)} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed">{p.copy}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ArchivedGroup({ label, count, open, onToggle, icon: Icon, tone, children }) {
  return (
    <div>
      <button onClick={onToggle} className="flex items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors">
        <Icon className={`h-3.5 w-3.5 ${tone}`} />
        {label}
        <span className="tabular-nums opacity-70">{count}</span>
        {open ? <ChevronUp className="h-3 w-3 opacity-60" /> : <ChevronDown className="h-3 w-3 opacity-60" />}
      </button>
      {open && <div className="mt-1 space-y-1.5">{children}</div>}
    </div>
  );
}

function ArchivedRow({ item, onReopen, busyKey }) {
  const busy = busyKey !== null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[12px]">
      <span className={`min-w-0 flex-1 truncate ${item.status === "dismissed" ? "text-muted-foreground/60 line-through" : "text-muted-foreground"}`}>{item.title}</span>
      <button onClick={onReopen} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors">
        <RotateCcw className="h-3 w-3" /> Reopen
      </button>
    </div>
  );
}