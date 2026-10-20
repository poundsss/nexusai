import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

// Runs one integration operation through the authorized Integration API's test_call, which
// executes the real externalTools path — retry, quota, breaker, rate-limit, IntegrationInvocation,
// tracing and scrubbing all apply exactly as a generated function experiences them.
export default function IntegrationTestDialog({ open, integration, onClose, onTest }) {
  const [op, setOp] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setResult(null); setError(null); setArgsText("{}");
    setOp(integration?.operations?.[0]?.name || "");
  }, [open, integration]);

  const run = async () => {
    let args = {};
    try { args = JSON.parse(argsText); }
    catch (e) { setError(`Arguments JSON: ${e.message}`); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await onTest(integration.name, op, args);
      setResult(r.result);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const ops = integration?.operations || [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Test {integration?.name}</DialogTitle>
          <DialogDescription>Runs through the real execution path — retry, quota, breaker, rate-limit and tracing all apply.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="int-op">Operation</Label>
            <select id="int-op" value={op} onChange={(e) => setOp(e.target.value)} className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm">
              {ops.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="int-args">Arguments (JSON)</Label>
            <Textarea id="int-args" value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={4} className="font-mono text-[12px]" />
          </div>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          {result && (
            <div className={`rounded border p-2 text-[12px] ${result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5"}`}>
              <div className="flex items-center gap-1.5 font-medium">
                {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                {result.ok ? `OK · ${result.status}` : `${result.code || "failed"}${result.kind ? ` · ${result.kind}` : ""}`}
              </div>
              <div className="text-muted-foreground mt-1">attempts: {result.attempts ?? 0}{result.status ? ` · status ${result.status}` : ""}</div>
              {result.message && <div className="mt-1 text-destructive">{result.message}</div>}
              {result.preview && <pre className="mt-1 max-h-32 overflow-auto font-mono text-[11px] text-muted-foreground">{result.preview}</pre>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={run} disabled={busy || !op}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}