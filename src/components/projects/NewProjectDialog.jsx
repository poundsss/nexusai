import React, { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Loader2, Sparkles, ArrowRight, Users, ShoppingCart, Package, CheckSquare } from "lucide-react";

const EXAMPLES = [
  { icon: Users, text: "A CRM for a sales team", prompt: "A CRM to manage contacts, deals, and a sales pipeline with a Kanban board" },
  { icon: ShoppingCart, text: "A marketplace for digital products", prompt: "A marketplace with product listings, a cart, checkout, and seller profiles" },
  { icon: Package, text: "An inventory management app", prompt: "An inventory tracker with products, stock levels, and low-stock alerts" },
  { icon: CheckSquare, text: "A project management tool", prompt: "A task manager with projects, due dates, priorities, and a team view" },
];

function deriveName(description) {
  if (!description) return "";
  let s = description.split(/[.!?\n]/)[0].trim();
  s = s.replace(/^(build|create|make|design|develop)\s+/i, "").replace(/^(me\s+)?(a|an|the)\s+/i, "");
  const words = s.split(/\s+/).slice(0, 4);
  let name = words.join(" ");
  if (name.length > 40) name = name.slice(0, 37) + "…";
  return name || "Untitled Project";
}

export default function NewProjectDialog({ open, onOpenChange, onCreate, initialDescription = "" }) {
  const [description, setDescription] = useState(initialDescription);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  React.useEffect(() => {
    if (open) {
      setDescription(initialDescription || "");
      setName("");
      setNameTouched(false);
      setError(null);
    }
  }, [open, initialDescription]);

  const derivedName = useMemo(() => deriveName(description), [description]);
  const projectName = nameTouched ? name : derivedName;

  const submit = async (e) => {
    e.preventDefault();
    if (!description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: (projectName || "Untitled Project").trim(), description: description.trim() });
    } catch (err) {
      // Keep the dialog open with the member's input so they can retry.
      setError(err?.response?.data?.error || err?.message || "Could not create the project. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] p-0 overflow-hidden">
        {/* Header band */}
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5 mb-3">
            <span className="grid place-items-center h-8 w-8 rounded-lg bg-muted text-foreground">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <DialogTitle className="text-[18px] font-bold tracking-tight">What do you want to build?</DialogTitle>
            </div>
          </div>
          <DialogDescription className="text-[13px]">
            Describe your application in plain language. NexusAI plans it, generates the code and data, builds it, and opens a live preview.
          </DialogDescription>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          {/* Prompt composer */}
          <div className="relative">
            <Textarea
              autoFocus
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Build a CRM with customers, deals, a dashboard, and search…"
              className="resize-none text-[14px] leading-relaxed border-border"
              aria-label="Project description"
            />
          </div>

          {/* Examples */}
          {!description.trim() && (
            <div>
              <div className="text-[11px] font-medium text-muted-foreground mb-2">Try one of these</div>
              <div className="grid gap-2">
                {EXAMPLES.map((ex) => {
                  const Icon = ex.icon;
                  return (
                    <button
                      key={ex.text}
                      type="button"
                      onClick={() => setDescription(ex.prompt)}
                      className="group flex items-center gap-2.5 rounded-md border border-border px-3 py-2 text-left hover:border-foreground/25 hover:bg-muted/50 transition-colors"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 text-[12px] text-muted-foreground group-hover:text-foreground transition-colors">{ex.text}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Project name */}
          {description.trim() && (
            <div className="space-y-1.5 animate-in fade-in duration-200">
              <label className="text-[12px] font-medium text-muted-foreground">Project name</label>
              <Input
                value={projectName}
                onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
                placeholder="Auto-derived from description"
                className="text-[13px]"
              />
            </div>
          )}

          {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !description.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
              {busy ? "Building…" : "Start building"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}