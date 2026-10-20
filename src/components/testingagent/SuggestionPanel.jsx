import React, { useState } from "react";
import { Loader2, Sparkles, Plus, Wand2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Prompt-scenario input + AI test suggestions via the existing `qa` `suggest` action (InvokeLLM).
// The user reviews suggestions and unchecks unwanted ones before adding them to the test list.
// Non-browser categories are marked runnable by the smoke engine; "scenario" items require a
// browser session and are shown as unavailable in the run list — never executed or fabricated.
export default function SuggestionPanel({ projectId, onAdd }) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [checked, setChecked] = useState({});

  const generate = async () => {
    if (!projectId || !prompt.trim() || loading) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("qa", { action: "suggest", project_id: projectId, prompt });
      const list = res.data?.suggestions || [];
      setSuggestions(list);
      setChecked(Object.fromEntries(list.map((s) => [s.id, true])));
      if (list.length === 0) toast({ title: "No suggestions", description: "The AI proposed no test scenarios for this prompt." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not generate suggestions", description: e.response?.data?.error || e.message });
    } finally { setLoading(false); }
  };

  const add = () => {
    const chosen = (suggestions || []).filter((s) => checked[s.id]);
    if (!chosen.length) return;
    onAdd(chosen);
    setSuggestions(null);
    setChecked({});
    setPrompt("");
  };

  return (
    <div className="rounded-md border border-border p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Wand2 className="h-3 w-3" />Prompt scenario
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe a flow to test, e.g. 'A user creates a task, marks it done, and filters by completed.'"
        rows={3}
        className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-[12px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2">
        <button onClick={generate} disabled={loading || !prompt.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-2.5 py-1 text-[11px] font-semibold hover:opacity-90 disabled:opacity-50">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}Generate tests with AI
        </button>
        <span className="text-[10.5px] text-muted-foreground/70">Uses credits even if you don't add the tests.</span>
      </div>

      {suggestions && (
        <div className="space-y-1.5 pt-1">
          <div className="text-[11px] text-muted-foreground">Review suggestions — uncheck any you don't want.</div>
          <ul className="space-y-1">
            {suggestions.map((s) => (
              <li key={s.id} className="flex items-start gap-2 rounded-md border border-border/60 px-2 py-1.5">
                <input type="checkbox" checked={!!checked[s.id]} onChange={(e) => setChecked((c) => ({ ...c, [s.id]: e.target.checked }))} className="h-3 w-3 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-foreground truncate">{s.label}</span>
                    <span className={`shrink-0 rounded px-1 text-[9.5px] ${s.smoke ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>
                      {s.smoke ? "smoke" : "browser"}
                    </span>
                  </div>
                  {s.description && <div className="text-[11px] text-muted-foreground break-words">{s.description}</div>}
                </div>
              </li>
            ))}
          </ul>
          <button onClick={add} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted">
            <Plus className="h-3 w-3" />Add tests
          </button>
        </div>
      )}
    </div>
  );
}