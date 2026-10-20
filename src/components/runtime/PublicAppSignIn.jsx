import React, { useEffect, useState } from "react";
import { Loader2, Lock, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Host-level sign-in screen for a published app that requires authentication
// (App Visibility 'private' / 'workspace'). Shown ONLY when the public runtime's serving
// gate refuses the artifact with 401 AUTH_REQUIRED. It reuses the EXISTING certified
// `appRuntime` auth operations — login, providers, oauth_begin — exactly as the deployed
// runtime exposes them; no new auth endpoint, session mechanism or provider is involved.
// The minted session token is handed back to the host page (PublicApp), which owns it like
// every other bridge session token. Provider buttons render ONLY the providers the runtime's
// server-side registry reports as configured (the registry is built from the project's own
// auth settings + sealed ProjectSecret; no credential or config internals cross here).
export default function PublicAppSignIn({ target, onAuthenticated }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [providers, setProviders] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const call = async (op, args = {}) => {
    const res = await base44.functions.invoke("appRuntime", { ...target, action: "auth", op, args });
    return res.data || {};
  };

  useEffect(() => {
    let cancelled = false;
    call("providers")
      .then((data) => { if (!cancelled) setProviders(data.providers || []); })
      .catch(() => { if (!cancelled) setProviders([]); });
    return () => { cancelled = true; };
  }, [target]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy("password");
    try {
      const data = await call("login", { email: email.trim(), password });
      if (data.session_token) onAuthenticated(data.session_token);
      else setError("Sign-in did not return a session. Please try again.");
    } catch (err) {
      setError(err.response?.data?.error || "Invalid email or password");
    } finally {
      setBusy(null);
    }
  };

  const signInWithProvider = async (provider) => {
    if (busy) return;
    setError(null);
    setBusy(provider);
    try {
      const data = await call("oauth_begin", { provider });
      if (data.authorization_url) window.location.href = data.authorization_url;
      else setError("This sign-in provider is not available right now.");
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(null);
    }
  };

  const label = (p) => p.charAt(0).toUpperCase() + p.slice(1);

  return (
    <div className="h-screen grid place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col items-center text-center">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-slate-100">
            <Lock className="h-4.5 w-4.5 text-slate-600" />
          </div>
          <h1 className="mt-3 text-[15px] font-semibold text-slate-900">Sign in required</h1>
          <p className="mt-1 text-[12.5px] text-slate-500">This application is only available to signed-in users.</p>
        </div>

        <form onSubmit={submit} className="mt-5 space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center rounded-md bg-slate-900 px-3 py-2 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy === "password" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
          </button>
        </form>

        {error && (
          <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-rose-600">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {providers && providers.length > 0 && (
          <React.Fragment>
            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-[11px] uppercase tracking-wide text-slate-400">or</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>
            <div className="space-y-2">
              {providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!!busy}
                  onClick={() => signInWithProvider(p)}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  {busy === p ? <Loader2 className="h-4 w-4 animate-spin" /> : `Continue with ${label(p)}`}
                </button>
              ))}
            </div>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}