import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

// Create / edit an integration by submitting its JSON definition through the authorized
// Integration API. The definition references credentials by secret NAME only — a value pasted
// here is rejected by the server's normalizer, never stored.
const TEMPLATE = {
  name: "myApi",
  type: "http",
  base_url: "https://api.example.com/v1",
  auth: { type: "none" },
  operations: [{ name: "go", method: "GET", path: "/ok" }],
};

// Fields the API adds at read time; strip them before sending a definition back so the
// normalizer sees a clean document.
const RUNTIME_FIELDS = ["id", "path", "secret_refs", "operation_count", "source"];

export default function IntegrationFormDialog({ open, mode, integration, onClose, onSubmit }) {
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === "update" && integration) {
      const def = { ...integration };
      for (const k of RUNTIME_FIELDS) delete def[k];
      setText(JSON.stringify(def, null, 2));
    } else {
      setText(JSON.stringify(TEMPLATE, null, 2));
    }
  }, [open, mode, integration]);

  const submit = async () => {
    let def;
    try { def = JSON.parse(text); }
    catch (e) { setError(`Invalid JSON: ${e.message}`); return; }
    setBusy(true);
    try {
      await onSubmit(def);
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "update" ? `Edit ${integration?.name || "integration"}` : "New integration"}</DialogTitle>
          <DialogDescription>Paste an integration definition. Credentials are referenced by secret name — never paste a value.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="int-def">Definition (JSON)</Label>
          <Textarea id="int-def" value={text} onChange={(e) => setText(e.target.value)} rows={16} className="font-mono text-[12px]" />
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}