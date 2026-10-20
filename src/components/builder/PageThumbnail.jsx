import React, { useRef } from "react";
import { AlertTriangle } from "lucide-react";

// Live, scaled-down render of one page, using the SAME preview bundle the Builder canvas
// runs. Once the frame is ready it is asked to show this page's route, so the thumbnail is
// the real application rather than a mock image.
export default function PageThumbnail({ srcdoc, route, bundleError }) {
  const ref = useRef(null);

  if (bundleError) {
    return (
      <div className="aspect-[4/3] grid place-items-center bg-muted/40 text-center px-4">
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" />Preview unavailable</p>
      </div>
    );
  }

  const goto = () => {
    if (route) ref.current?.contentWindow?.postMessage({ type: "runtime:goto", path: route }, "*");
  };

  return (
    <div className="aspect-[4/3] overflow-hidden bg-background">
      <iframe
        ref={ref}
        onLoad={goto}
        title={`Page preview ${route || ""}`}
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        className="origin-top-left border-0 pointer-events-none"
        style={{ width: "1280px", height: "960px", transform: "scale(0.28)" }}
      />
    </div>
  );
}