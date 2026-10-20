import React, { useState, useRef, useEffect } from "react";
import { Palette, Check, ChevronDown, Upload } from "lucide-react";
import DesignSystemImport from "./DesignSystemImport";
import DesignSystemMark from "./DesignSystemMarks";

// Static list MIRRORING the backend registry (base44/shared/designSystemPresets.ts): only
// systems the NexusAI generated-app runtime can actually use are selectable. Unsupported
// libraries (Material UI, Chakra — npm React packages the plain-ESM preact-htm runtime cannot
// consume) are listed but visibly unavailable, so the menu matches the Bolt layout without
// pretending support that does not exist.
const SYSTEMS = [
  { id: "chakra", name: "Chakra", category: "open_source", supported: false, note: "Chakra UI — npm React package, not usable in this runtime" },
  { id: "material-ui", name: "Material UI", category: "open_source", supported: false, note: "npm React package — not usable in this runtime" },
  { id: "shadcn", name: "Shadcn", category: "open_source", supported: true, note: "Copy-in components, authored in-project" },
  // Corporate design-language presets (Bolt parity): the real systems ship as npm/web-component
  // libraries this runtime cannot import, so selecting one instructs the Build to author
  // components in-project in the system's published design language.
  { id: "washington-post", name: "Washington Post", category: "corporate", supported: true, note: "WPDS design language — components authored in-project" },
  { id: "cloudscape", name: "AWS Cloudscape", category: "corporate", supported: true, note: "Cloudscape design language — components authored in-project" },
  { id: "porsche", name: "Porsche", category: "corporate", supported: true, note: "Porsche design language — components authored in-project" },
];

// Compact design-system selector for the Builder chat, next to the model selector. The
// selection persists per project through the authorized builder-settings surface and feeds
// NEW Build runs only — it never rewrites existing files. Phase 2: "Import your design
// system" opens a compact source picker (GitHub / npm / paste files); a successful import
// flows through the SAME onChange path, so persistence, display and Build-context injection
// are all the existing selection behavior.
export default function DesignSystemMenu({ value, importedName = null, projectId = null, onChange, disabled, dark = false }) {
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = value ? SYSTEMS.find((s) => s.id === value) : null;
  const isImported = !!value && !selected;
  const label = selected?.name || (isImported ? (importedName || "Imported system") : "Design");
  const trigger = dark
    ? "border-white/10 text-white/80 hover:text-white hover:border-white/25"
    : "border-border bg-background text-foreground hover:border-foreground/30";
  // Dark variant for the popup itself, so the menu on the dark Home surface stays black.
  const panelCls = dark ? "border-white/10 bg-[#171717]" : "border-border bg-popover";
  const hoverCls = dark ? "hover:bg-white/[0.07]" : "hover:bg-accent/60";
  const mutedCls = dark ? "text-white/50" : "text-muted-foreground";
  const fgCls = dark ? "text-white" : "text-popover-foreground";
  const circleCls = dark ? "bg-white/[0.08]" : "bg-muted";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={selected ? `${selected.name} — selected design system` : isImported ? `${label} — imported design system` : "Design system for new Builds"}
        className={`flex items-center gap-1 h-8 min-w-[68px] justify-between rounded-lg border px-2 text-[12px] font-medium transition-colors disabled:opacity-50 ${trigger}`}
      >
        <Palette className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[110px] truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className={`absolute bottom-full mb-2 left-0 z-50 w-[400px] max-w-[92vw] rounded-xl border ${panelCls} shadow-xl overflow-hidden`}>
          <div className={`px-3 pt-2.5 pb-1.5 text-[11px] font-medium ${mutedCls}`}>Design system</div>

          {/* None (default) — the project's existing design behavior */}
          <button
            onClick={() => { onChange(null); setOpen(false); }}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left ${hoverCls} transition-colors`}
          >
            <span className={`h-7 w-7 rounded-full ${circleCls} grid place-items-center shrink-0`}>
              <Palette className={`h-3.5 w-3.5 ${mutedCls}`} />
            </span>
            <div className="flex-1 min-w-0">
              <div className={`text-[12.5px] font-semibold ${fgCls}`}>None</div>
              <div className={`text-[11px] ${mutedCls}`}>Use the project's current design</div>
            </div>
            {!value && <Check className="h-4 w-4 shrink-0" />}
          </button>

          {/* The imported system, when one is selected — a project-owned DesignSystem row */}
          {isImported && (
            <div className={`px-3 pt-2 pb-1 text-[11px] font-medium ${mutedCls}`}>Imported</div>
          )}
          {isImported && (
            <button
              onClick={() => setOpen(false)}
              title={`${label} — imported design system`}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left ${hoverCls} transition-colors`}
            >
              <span className={`h-7 w-7 rounded-full ${circleCls} grid place-items-center shrink-0`}>
                <Upload className={`h-3.5 w-3.5 ${mutedCls}`} />
              </span>
              <div className="flex-1 min-w-0">
                <div className={`text-[12.5px] font-semibold ${fgCls} truncate`}>{importedName || "Imported design system"}</div>
                <div className={`text-[11px] ${mutedCls} truncate`}>Imported — applies to new Builds</div>
              </div>
              <Check className="h-4 w-4 shrink-0" />
            </button>
          )}

          {/* Two columns side by side, Bolt-style: Open source | Corporate */}
          <div className="grid grid-cols-2 gap-x-1 px-1 pb-1">
            {[["Open source", "open_source"], ["Corporate", "corporate"]].map(([sectionLabel, category]) => (
              <div key={category}>
                <div className={`px-2 pt-2 pb-1 text-[11px] font-medium ${mutedCls}`}>{sectionLabel}</div>
                {SYSTEMS.filter((s) => (s.category || "open_source") === category).map((s) => (
                  <button
                    key={s.id}
                    disabled={!s.supported}
                    onClick={() => { onChange(s.id); setOpen(false); }}
                    title={s.supported ? s.name : s.note}
                    className={`w-full flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${s.supported ? hoverCls : "opacity-40 cursor-not-allowed"}`}
                  >
                    <DesignSystemMark id={s.id} />
                    <div className={`flex-1 min-w-0 truncate text-[13px] font-semibold ${fgCls}`}>{s.name}</div>
                    {value === s.id && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Importing needs a project to own the imported DesignSystem row — offered only inside the Builder. */}
          {projectId && (
            <div className={`border-t ${dark ? "border-white/10" : "border-border"} p-1`}>
              <button
                onClick={() => { setImportOpen(true); }}
                className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left ${hoverCls} transition-colors`}
              >
                <Upload className={`h-4 w-4 shrink-0 ${mutedCls}`} />
                <div className="flex-1 min-w-0">
                  <div className={`text-[12.5px] font-semibold ${fgCls}`}>Import your design system</div>
                  <div className={`text-[11px] ${mutedCls}`}>GitHub · npm · paste files</div>
                </div>
              </button>
            </div>
          )}
        </div>
      )}

      {importOpen && (
        <DesignSystemImport
          projectId={projectId}
          onClose={() => setImportOpen(false)}
          onImported={(imported) => {
            setImportOpen(false);
            setOpen(false);
            onChange(imported.id);
          }}
        />
      )}
    </div>
  );
}