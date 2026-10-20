import React, { useEffect, useState } from "react";
import { KeyRound, Loader2, Check } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import SecretRow from "./SecretRow";

// Values only ever travel INTO the server. This panel never receives a secret value.
export default function SecretsPane({ projectId }) {
  const [secrets, setSecrets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const call = async (payload) => {
    const res = await base44.functions.invoke("projectSecrets", { project_id: projectId, ...payload });
    setSecrets(res.data.secrets || []);
  };

  useEffect(() => {
    call({ action: "list" }).catch((e) => toast({ variant: "destructive", title: "Could not load secrets", description: e.message })).finally(() => setLoading(false));
  }, [projectId]);

  const guarded = async (payload, okTitle) => {
    setBusy(true);
    try { await call(payload); if (okTitle) toast({ title: okTitle }); }
    catch (e) { toast({ variant: "destructive", title: "Failed", description: e.response?.data?.error || e.message }); }
    finally { setBusy(false); }
  };

  const add = async (e) => {
    e.preventDefault();
    if (!name.trim() || !value) return;
    await guarded({ action: "set", name: name.trim().toUpperCase(), value }, `${name.trim().toUpperCase()} saved`);
    setName(""); setValue("");
  };

  const missing = secrets.filter((s) => s.required && !s.is_set).length;

  return (
    <div className="h-full overflow-auto p-5 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold tracking-tight">Secrets</h2>
        {missing > 0 && <span className="rounded-full bg-amber-500/10 text-amber-600 px-2 py-0.5 text-[11px]">{missing} missing value{missing > 1 ? "s" : ""}</span>}
      </div>
      <p className="text-muted-foreground mb-4">API keys and credentials for this app's backend functions. Values are stored server-side, never shown again, and never given to the AI or included in versions.</p>

      <form onSubmit={add} className="flex flex-col sm:flex-row gap-2 mb-5">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="SECRET_NAME" className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-[12px] uppercase" />
        <input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="value" className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-[12px]" />
        <button disabled={busy || !name.trim() || !value} className="flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-[12px] hover:bg-primary/90 transition-colors disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Save
        </button>
      </form>

      {loading ? (
        <div className="text-muted-foreground/60 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : secrets.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-muted-foreground/60">No secrets yet. The AI declares them when a feature needs one.</div>
      ) : (
        <div className="divide-y divide-border/40 rounded-md border border-border">
          {secrets.map((s) => (
            <SecretRow key={s.name} secret={s} busy={busy}
              onSet={(v) => guarded({ action: "set", name: s.name, value: v }, `${s.name} updated`)}
              onDelete={() => guarded({ action: "delete", name: s.name }, `${s.name} removed`)} />
          ))}
        </div>
      )}
    </div>
  );
}