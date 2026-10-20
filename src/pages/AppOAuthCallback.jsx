import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";

// OAuth callback for a DEPLOYED application. P-9.8 social sign-in: the provider redirects here
// with ?provider=&state=&code=; this page hands them to the public runtime, which consumes the
// single-use state, exchanges the code server-side and mints the app's own AppSession (the
// HttpOnly cookie is set by that response). P-9.9 app user connectors use the SAME route with
// ?connector=&state=&code=: for a BUILDER-initiated connection (Meetings / Plugins in the
// workspace shell, no slug) the page completes the flow through the delegatedOAuth contract
// directly; for a deployed app it goes through the runtime. The browser is then returned.
export default function AppOAuthCallback() {
  const { slug } = useParams();
  const [error, setError] = useState(null);
  const connectorFlow = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("connector");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const provider = q.get("provider");
    const connector = q.get("connector");
    const projectId = q.get("project_id");
    const state = q.get("state");
    const code = q.get("code");
    const providerError = q.get("error");
    const target = slug ? { slug } : { host: window.location.host };
    (async () => {
      const tikTokKey = state ? `nexus-tiktok-oauth:${state}` : null;
      const tikTokStored = tikTokKey ? sessionStorage.getItem(tikTokKey) : null;
      if (tikTokStored) {
        try {
          const { projectId: tikTokProjectId } = JSON.parse(tikTokStored);
          if (providerError || !code) throw new Error(`TikTok authorization was not completed: ${providerError || "missing code"}`);
          await base44.functions.invoke("virality", { action: "tiktok_oauth_callback", project_id: tikTokProjectId, state, code });
          sessionStorage.removeItem(tikTokKey);
          window.location.href = "/growth-agent?tiktok=connected";
        } catch (e) { setError(e.response?.data?.error || e.message); }
        return;
      }
      if (providerError) { setError(`The sign-in provider reported: ${providerError}`); return; }
      if (!state || !code || (!provider && !connector)) { setError("This callback link is not valid."); return; }
      try {
        if (connector && !slug && projectId) {
          // Builder-initiated connector connection — complete through the certified contract.
          // The server exchanges with the redirect bound to the state at begin; none is sent.
          await base44.functions.invoke("delegatedOAuth", { action: "callback", project_id: projectId, state, code });
          window.location.href = "/meetings";
          return;
        }
        const res = await base44.functions.invoke("appRuntime", { ...target, action: "auth", op: "oauth_callback", args: { provider, connector, state, code } });
        // loginWithProvider(provider, fromUrl) parity: when the flow carried a validated
        // post-login destination, return the user THERE; the fixed destination stays the fallback.
        const postLogin = res?.data?.result?.post_login_url;
        window.location.href = postLogin || (slug ? `/app/${slug}` : "/");
      } catch (e) {
        setError(e.response?.data?.error || e.message);
      }
    })();
  }, [slug]);

  return (
    <div className="h-screen grid place-items-center p-8 text-center">
      {error ? (
        <div>
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-500" />
          <p className="mt-2 font-medium">{connectorFlow ? "Connection failed" : "Sign-in failed"}</p>
          <p className="mt-1 font-mono text-[12px] text-slate-500">{error}</p>
          <a className="mt-4 inline-block text-[12.5px] text-blue-600 hover:underline" href={slug ? `/app/${slug}` : "/"}>
            Back to the app
          </a>
        </div>
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      )}
    </div>
  );
}