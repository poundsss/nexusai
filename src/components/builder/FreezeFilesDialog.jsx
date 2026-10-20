import React, { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Lock } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Freeze Files picker (documented Base44 Builder "More options" entry). A file-SELECTION workflow:
// the user multi-selects project files to freeze, and only the files whose frozen state CHANGED
// are written on Save. Reuses the existing ProjectFile.frozen contract (ProjectFile.update) —
// no schema, no backend, no enforcement change. Frozen enforcement stays in projectFs/AI tools.
const GROUPS = [
  { key: "Pages", test: (p) => p.startsWith("src/pages/") },
  { key: "Components", test: (p) => p.startsWith("src/components/") },
  { key: "Functions", test: (p) => p.startsWith("functions/") },
  { key: "Integrations", test: (p) => p.startsWith("integrations/") },
  { key: "Files", test: () => true },
];

function groupFiles(files) {
  const out = GROUPS.map((g) => ({ ...g, files: [] }));
  for (const f of files) {
    for (const g of out) {
      if (g.test(f.path)) { g.files.push(f); break; }
    }
  }
  return out.filter((g) => g.files.length);
}

export default function FreezeFilesDialog({ open, files = [], onClose, onSaved }) {
  // path -> desired frozen state. Seeded from the current ProjectFile.frozen each time the
  // dialog opens, so it always reflects the latest persisted state (e.g. after a CodeViewer toggle).
  const [state, setState] = useState(() => Object.create(null));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next = Object.create(null);
    for (const f of files) next[f.path] = !!f.frozen;
    setState(next);
  }, [open, files]);

  const grouped = useMemo(() => groupFiles(files), [files]);
  const frozenCount = Object.values(state).filter(Boolean).length;
  // Diff against the persisted values to find what actually needs writing.
  const changed = files.filter((f) => !!state[f.path] !== !!f.frozen);

  const toggle = (path) => setState((s) => ({ ...s, [path]: !s[path] }));

  const save = async () => {
    if (!changed.length) { onClose?.(); return; }
    setSaving(true);
    try {
      // Only the files whose state CHANGED are written. Reuses the existing per-record update
      // contract (same call CodeViewer's toggle uses), so branch/version/snapshot semantics are
      // unchanged. Updates are independent; a failure leaves prior writes applied (best-effort).
      await base44.functions.invoke("projectFileFreeze", {
        project_id: changed[0].project_id,
        updates: changed.map((f) => ({ file_id: f.id, frozen: !!state[f.path] })),
      });
      await onSaved?.();
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose?.(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Freeze Files</DialogTitle>
          <DialogDescription>
            Select files to protect from Build-mode AI changes. Frozen files stay readable; the AI cannot modify or delete them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
          <span>{frozenCount} frozen{changed.length ? ` · ${changed.length} unsaved` : ""}</span>
        </div>

        <ScrollArea className="h-[320px] rounded-lg border border-border">
          <div className="p-1">
            {grouped.length === 0 && (
              <div className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">No project files yet.</div>
            )}
            {grouped.map((g) => (
              <div key={g.key} className="mb-2">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                  {g.key} <span className="font-mono normal-case">{g.files.length}</span>
                </div>
                {g.files.map((f) => {
                  const checked = !!state[f.path];
                  return (
                    <label
                      key={f.id || f.path}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50 cursor-pointer"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggle(f.path)} aria-label={`Freeze ${f.path}`} />
                      <span className="truncate font-mono text-[12px] text-foreground">{f.path}</span>
                      {f.frozen && !checked ? (
                        <span className="ml-auto text-[10px] text-amber-600">was frozen</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || changed.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : `Save${changed.length ? ` (${changed.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}