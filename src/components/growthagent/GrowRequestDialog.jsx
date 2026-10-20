import React, { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import BrandIcon from "@/components/brand/BrandIcon";

// One parameter dialog for every Grow subcategory: it collects the parameters the certified
// backend surface needs, previews the generated request, and on confirm hands the text to the
// Chat composer — it NEVER sends anything and NEVER calls the backend itself (the Growth Agent
// runs the named certified surface when the member presses Send).
export default function GrowRequestDialog({ pick, projects, projectId, onClose, onGenerate }) {
  const [values, setValues] = useState({});
  const sub = pick?.sub || null;
  const mod = pick?.module || null;

  useEffect(() => { setValues({}); }, [sub?.id]);

  const project = projects.find((p) => p.id === projectId) || null;
  const promptText = useMemo(() => {
    if (!sub) return "";
    try { return sub.prompt(values, project); } catch { return ""; }
  }, [sub, values, project]);

  if (!sub) return null;
  const fields = sub.fields || [];
  const missing = fields.filter((f) => f.required && !String(values[f.key] || "").trim());
  const needsProject = projects.length > 1 && !projectId;

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            {typeof sub.icon === "string"
              ? <BrandIcon name={sub.icon} className="h-4 w-4" />
              : sub.icon && <sub.icon className="h-4 w-4 text-muted-foreground" />}
            {sub.label}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {mod?.label}{sub.blurb ? ` — ${sub.blurb}` : ""}
          </DialogDescription>
        </DialogHeader>

        {fields.length > 0 && (
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <label className="text-[12px] font-medium text-muted-foreground">
                  {f.label}{f.required ? " *" : ""}
                </label>
                {f.multiline ? (
                  <Textarea
                    rows={3}
                    value={values[f.key] || ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                  />
                ) : (
                  <Input
                    value={values[f.key] || ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border bg-muted/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Request</p>
          <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed">{promptText}</p>
        </div>

        {projects.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No projects yet — the request runs without a project.</p>
        ) : needsProject ? (
          <p className="text-[12px] text-amber-600 dark:text-amber-400">
            Multiple projects exist — choose one in the composer above the message input before running product-specific actions.
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={needsProject || missing.length > 0} onClick={() => onGenerate(promptText)}>
            Insert into chat
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}