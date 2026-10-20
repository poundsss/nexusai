import React, { useCallback, useEffect, useState } from "react";
import { Cable, Loader2, X, Link2, Unlink, RefreshCw, AlertTriangle, LogIn } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Published-app connector panel — the certified `appRuntime` `connectors` surface (P-9.9) for the
// SIGNED-IN app user of a published app. It uses ONLY the existing ops:
//   • list        (read-only discovery, no session) — declared connectors metadata
//   • connections (session)  — the current user's delegated credentials
//   • connect     (session)  — begins OAuth, returns authorization_url (host redirects)
//   • disconnect  (session)  — revokes the user's active credentials for a connector
// The host (PublicApp) owns the app-user session token; this panel reads it via sessionRef. No
// provider discovery or connector contract is invented — `list` is the artifact's own declared
// connectors, and connect/connections/disconnect are the existing certified ops.
const STATUS_TONE = {
  active: "bg-emerald-500/10 text-emerald-600", expired: "bg-amber-500/10 text-amber-600",
  revoked: "bg-muted text-muted-foreground", error: "bg-destructive/10 text-destructive",
};

export default function PublicAppConnections({ target, sessionRef, signedIn }) {
  const [open, setOpen] = useState(false);
  const [connectors, setConnectors] = useState(null);
  const [connections, setConnections] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const call = useCallback(async (op, args = {}) => {
    const res = await base44.functions.invoke("appRuntime", { ...target, action: "connectors", op, args, session_token: sessionRef.current });
    const data = res.data || {};
    if (data.error) throw new Error(data.error);
    return data.result;
  }, [target, sessionRef]);

  const load = useCallback(async () => {
    setError(null);
    // list is read-only discovery (no session needed); connections needs the app-user session.
    const tasks = [call("list").then((r) => setConnectors(r?.connectors || [])).catch((e) => { setConnectors([]); throw e; })];
    if (signedIn) tasks.push(call("connections").then((r) => setConnections(r?.connections || [])).catch(() => setConnections([])));
    else setConnections([]);
    try { await Promise.all(tasks); }
    catch (e) { setError(e.response?.data?.error || e.message); }
  }, [call, signedIn]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const connect = async (name) => {
    setBusy(name);
    try {
      const r = await call("connect", { connector: name });
      if (r?.authorization_url) window.location.href = r.authorization_url;
      else setError("No authorization URL returned");
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const disconnect = async (name) => {
    if (!confirm(`Disconnect ${name}? This revokes your credentials for this connector.`)) return;
    setBusy(`d:${name}`);
    try { await call("disconnect", { connector: name }); await load(); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const connsFor = (name) => (connections || []).filter((c) => c.provider_id === name && c.status !== "revoked");

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title="My connections"
        className="fixed top-3 right-3 z-40 inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/90 px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm backdrop-blur hover:bg-white"
      >
        <Cable className="h-3.5 w-3.5" />Connections
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative w-full max-w-sm h-full bg-white shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
              <Cable className="h-4 w-4 text-slate-500" />
              <h3 className="text-sm font-semibold flex-1 text-slate-800">My connections</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {!signedIn && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 flex items-start gap-2">
                  <LogIn className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-[12px] text-amber-800">Sign in to this app to connect your own accounts. Connectors you link here belong to your profile only.</p>
                </div>
              )}
              {error && (
                <div className="rounded-md border border-red-200 bg-red-50 p-2.5 flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-red-600 mt-0.5 shrink-0" />
                  <p className="text-[12px] text-red-700">{error}</p>
                </div>
              )}
              {connectors === null ? (
                <div className="text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /></div>
              ) : connectors.length === 0 ? (
                <p className="text-[12.5px] text-slate-400 py-4 text-center">This app declares no connectors.</p>
              ) : (
                connectors.map((c) => {
                  const active = connsFor(c.name);
                  return (
                    <div key={c.name} className="rounded-md border border-slate-200 p-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12.5px] text-slate-800">{c.name}</span>
                        {active.length > 0 && <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[active[0].status] || "bg-slate-100 text-slate-600"}`}>{active[0].status}</span>}
                        <div className="ml-auto flex items-center gap-1">
                          {signedIn && active.length === 0 && (
                            <button onClick={() => connect(c.name)} disabled={busy === c.name} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium hover:bg-slate-50 disabled:opacity-50">
                              {busy === c.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}Connect
                            </button>
                          )}
                          {signedIn && active.length > 0 && (
                            <button onClick={() => disconnect(c.name)} disabled={busy === `d:${c.name}`} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                              {busy === `d:${c.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}Disconnect
                            </button>
                          )}
                        </div>
                      </div>
                      {c.description && <p className="mt-1 text-[11.5px] text-slate-500">{c.description}</p>}
                      {active.length > 0 && (
                        <div className="mt-1.5 text-[11px] text-slate-500">
                          {active[0].external_subject || active[0].external_email || "connected"}
                          {active[0].expires_at && <> · expires {new Date(active[0].expires_at).toLocaleDateString()}</>}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="px-4 py-2.5 border-t border-slate-200">
              <button onClick={load} className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 hover:text-slate-700"><RefreshCw className="h-3 w-3" />Refresh</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}