import React, { useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { bundlePreview } from "@/lib/runtime/previewBundle";

const invoke = (payload) => base44.functions.invoke("nexusCode", payload);

// Per-branch DEVELOPMENT preview (the confirmed Base44 branch-preview gap): reads the active
// working branch's files through the nexusCode surface and bundles them CLIENT-SIDE with the
// SAME sandboxed runtime as the Builder preview (bundlePreview). Development-only by
// construction — no deployment is created and production serving is untouched; release stays
// with the existing deployment flow. The preview is tied to the session's selected branch:
// it re-reads when the branch or its head changes, and fails closed on out-of-band movement.
export default function PreviewPanel({ session, refreshKey = 0 }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [srcdoc, setSrcdoc] = useState(null);
  const [manualTick, setManualTick] = useState(0);
  const iframeRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setRuntimeError(null); setSrcdoc(null);
    (async () => {
      try {
        const r = await invoke({ action: "preview_files", session_id: session.id });
        if (!alive) return;
        try {
          setSrcdoc(bundlePreview((r.data?.files || []).map((f) => ({ path: f.path, content: f.content || "" }))));
        } catch (e) {
          setError(e.message);
        }
      } catch (e) {
        if (!alive) return;
        setError(e.response?.data?.error || e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [session.id, session.working_branch, refreshKey, manualTick]);

  useEffect(() => {
    const onMessage = (e) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (e.data?.type === "runtime:error") setRuntimeError(String(e.data.message || e.data));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const shown = runtimeError || error;

  const statusCard = (icon, title, message) => (
    <div className="h-full flex items-center justify-center p-8 text-center">
      <div>
        {icon}
        <p className="mt-3 text-[14px] font-medium">{title}</p>
        <p className="mt-1 text-[12px] text-muted-foreground font-mono break-all">{message}</p>
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border">
        <span className="text-[11px] text-muted-foreground truncate">
          Development preview · {session.working_branch || session.base_branch} · not production
        </span>
        <button
          onClick={() => setManualTick((t) => t + 1)}
          className="ml-auto grid place-items-center h-6 w-6 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Reload preview"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 min-h-0 bg-background overflow-hidden">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : shown ? (
          statusCard(<AlertTriangle className="h-6 w-6 mx-auto text-amber-500" />, "Preview unavailable", shown)
        ) : (
          <iframe
            ref={iframeRef}
            key={`${refreshKey}:${manualTick}`}
            title="Branch development preview"
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            srcDoc={srcdoc}
            className="h-full w-full border-0"
          />
        )}
      </div>
    </div>
  );
}