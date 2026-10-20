import React from "react";
import { Monitor, Tablet, Smartphone } from "lucide-react";
import { PHONE_DEFAULT, TABLET_DEFAULT } from "./deviceModels";

// Header presets: tapping a device icon immediately frames the preview at that device's
// default size. The full model list + zoom live in the in-canvas DeviceToolbar above the frame.
export default function DevicePicker({ viewport, onViewport }) {
  const isDesktop = viewport === "desktop";
  const current = !isDesktop ? viewport : null;
  const isPhone = current && current.width < 600;
  const isTablet = current && current.width >= 600;

  const deviceBtn = (active) =>
    "h-6 w-6 grid place-items-center rounded-full transition-all " +
    (active ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground/60 hover:text-foreground");

  return (
    <div className="relative flex items-center rounded-full bg-muted p-0.5 shrink-0" role="group" aria-label="Preview device">
      <button onClick={() => onViewport("desktop")} className={deviceBtn(isDesktop)} aria-label="Desktop viewport" title="Desktop">
        <Monitor className="h-3.5 w-3.5" />
      </button>
      <button onClick={() => onViewport(TABLET_DEFAULT)} className={deviceBtn(isTablet)} aria-label="Tablet viewport" title="Tablet">
        <Tablet className="h-3.5 w-3.5" />
      </button>
      <button onClick={() => onViewport(PHONE_DEFAULT)} className={deviceBtn(isPhone)} aria-label="Mobile viewport" title="Mobile">
        <Smartphone className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}