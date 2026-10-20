import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { bundlePreview } from "@/lib/runtime/previewBundle";
import usePackageModules from "@/hooks/usePackageModules";
import { handleBridgeCall, startStreamFrames, handleStreamControlMessage } from "@/lib/runtime/dbBridge";
import CollaboratorPresence from "./CollaboratorPresence";
import CollaboratorCursors from "./CollaboratorCursors";
import DeviceToolbar from "./DeviceToolbar";
import IssuesFoundNotice from "./IssuesFoundNotice";
import { useCollaborators } from "@/hooks/useCollaborators";

// The canvas renders the project's WORKING files, bundled in the browser. Device framing is
// chosen in the Builder header; this pane renders it and reports runtime status.
export default function PreviewPane({ projectId, files, entities, onRuntimeError, runtimeErrors, onClearErrors, gotoRoute, viewport = "desktop", onViewport, refreshSignal = 0, versionKey = 0, picker = false, onElementSelect, onResolveErrors, resolveDisabled = false }) {
  const [gen, setGen] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [mountDiag, setMountDiag] = useState(null);
  useEffect(() => { setMountDiag(null); }, [versionKey, gen]);
  const iframeRef = useRef(null);
  const { collaborators, sendCursor, sendSelection } = useCollaborators(projectId);

  // The header's reload re-bundles the preview canvas — the Builder page itself stays put.
  useEffect(() => { if (refreshSignal) setGen(refreshSignal); }, [refreshSignal]);

  const pkg = usePackageModules(projectId, files);
  const bundle = useMemo(() => {
    if (pkg.loading) return { srcdoc: "" };
    if (pkg.error) return { error: pkg.error };
    try { return { srcdoc: bundlePreview(files, { picker, packages: pkg.packages }) }; } catch (e) { return { error: e.message }; }
  }, [files, gen, picker, pkg.loading, pkg.error, pkg.packages]);

  useEffect(() => {
    const onMessage = async (e) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const m = e.data || {};
      if (m.type === "runtime:error") {
        onRuntimeError(m.message);
        // Fire-and-forget: persistence failure never affects the Preview.
        base44.functions.invoke("previewErrorReport", { project_id: projectId, message: String(m.message || ""), version_number: versionKey || undefined, user_agent: navigator.userAgent }).catch(() => {});
      }
      // Local diagnostic only — never persisted, never treated as a runtime error.
      if (m.type === "runtime:mounted") setMountDiag(m.visible === false ? m : null);
      if (m.type === "runtime:element-select") {
        if (!m.cancelled && m.route != null && m.elementId != null) sendSelection({ route: m.route, elementId: m.elementId, t: Date.now() });
        onElementSelect?.(m);
      }
      if (m.type === "runtime:cursor") sendCursor({ x: m.x, y: m.y, viewport, route: m.route, t: m.t });
      if (handleStreamControlMessage(m)) return;
      if (m.type === "bridge:call") {
        try {
          const result = await handleBridgeCall(projectId, entities, m);
          // Streaming (multi-frame bridge): the result is a stream descriptor — the host pumps
          // its chunks to the iframe as frames instead of one buffered result.
          if (result && result.__stream_bridge__) startStreamFrames(result.response, e.source, m.id);
          else e.source.postMessage({ type: "bridge:result", id: m.id, result }, "*");
        } catch (err) {
          e.source.postMessage({ type: "bridge:result", id: m.id, error: err.message, ...(err.bridgeDetail ? { error_detail: err.bridgeDetail } : {}) }, "*");
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [projectId, versionKey, entities, onRuntimeError, onElementSelect, sendCursor, sendSelection]);

  // A page chosen in the page overview is shown here, in the main canvas.
  const applyGoto = () => {
    if (!gotoRoute) return;
    iframeRef.current?.contentWindow?.postMessage({ type: "runtime:goto", path: gotoRoute }, "*");
  };
  useEffect(applyGoto, [gotoRoute]);

  const devW = typeof viewport === "object" && viewport ? viewport.width : null;
  const devH = typeof viewport === "object" && viewport ? viewport.height : null;
  const isDevice = viewport !== "desktop";
  const isPhone = devW ? devW < 600 : viewport === "mobile";
  const viewportWidth = viewport === "mobile" ? "w-[390px]" : viewport === "tablet" ? "w-[768px]" : "w-full";
  const deviceStyle = devW ? { width: `${devW}px`, maxWidth: "100%", height: devH ? `${devH}px` : undefined, maxHeight: "100%" } : undefined;
  // Desktop is edge-to-edge like the reference; a chosen device gets a framed screen.
  const frame = isDevice
    ? `${isPhone ? "rounded-[28px]" : "rounded-[16px]"} shadow-lg ring-1 ring-border`
    : "";
  // Zoom scales the device frame; the wrapper reserves the scaled height so centering holds.
  const scale = zoom / 100;
  const scaledHeight = devH ? Math.round(devH * scale) : null;

  return (
    <div className="relative h-full bg-muted/30">
      {/* Floating device controls overlay the canvas — separate pills, no bar background. */}
      {mountDiag && (
        <div className="absolute bottom-3 left-3 z-10 rounded-md border bg-background/95 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm">
          No visible content detected on {mountDiag.route} ({mountDiag.nodes} nodes) — may be intentional or still loading.
        </div>
      )}
      {onResolveErrors && runtimeErrors?.length > 0 && (
        <IssuesFoundNotice errors={runtimeErrors} onResolve={onResolveErrors} onDismiss={onClearErrors} disabled={resolveDisabled} />
      )}
      {isDevice && <DeviceToolbar viewport={viewport} onViewport={onViewport} zoom={zoom} onZoom={setZoom} />}
      {/* Preview canvas */}
      <div className={`h-full flex justify-center items-start overflow-auto scrollbar-thin ${isDevice ? "pt-14 px-4 pb-4" : ""}`}>
        {isDevice ? (
          <div style={{ height: scaledHeight ? `${scaledHeight}px` : undefined }} className="flex justify-center">
            <div
              className={`relative bg-background overflow-hidden transition-all ${frame}`}
              style={{ ...deviceStyle, transform: `scale(${scale})`, transformOrigin: "top center" }}
            >
              <CollaboratorPresence projectId={projectId} />
              {bundle.error ? (
                <div className="h-full flex items-center justify-center p-8 text-center">
                  <div>
                    <AlertTriangle className="h-6 w-6 mx-auto text-amber-500" />
                    <p className="mt-3 text-[14px] font-medium">Preview unavailable</p>
                    <p className="mt-1 text-[12px] text-muted-foreground font-mono">{bundle.error}</p>
                  </div>
                </div>
              ) : (
                <>
                  <iframe key={`${versionKey}:${gen}`} ref={iframeRef} onLoad={applyGoto} title="App preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={bundle.srcdoc} className="h-full w-full border-0" />
                  <CollaboratorCursors collaborators={collaborators} iframeRef={iframeRef} route={gotoRoute} viewport={viewport} />
                </>
              )}
            </div>
          </div>
        ) : (
          <div className={`relative h-full bg-background overflow-hidden transition-all ${viewportWidth}`}>
            <CollaboratorPresence projectId={projectId} />
            {bundle.error ? (
              <div className="h-full flex items-center justify-center p-8 text-center">
                <div>
                  <AlertTriangle className="h-6 w-6 mx-auto text-amber-500" />
                  <p className="mt-3 text-[14px] font-medium">Preview unavailable</p>
                  <p className="mt-1 text-[12px] text-muted-foreground font-mono">{bundle.error}</p>
                </div>
              </div>
            ) : (
              <>
                <iframe key={`${versionKey}:${gen}`} ref={iframeRef} onLoad={applyGoto} title="App preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={bundle.srcdoc} className="h-full w-full border-0" />
                <CollaboratorCursors collaborators={collaborators} iframeRef={iframeRef} route={gotoRoute} viewport={viewport} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}