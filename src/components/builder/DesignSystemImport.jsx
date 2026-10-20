import React, { useState } from "react";
import { Loader2, X, Github, Package, FileText, Check } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Compact source picker for importing a design system (Phase 2). Only the three sources the
// import surface actually supports are offered; each has its own bounded inputs. On success the
// imported row id flows through the existing selection handler, so persistence, display and the
// Build-context injection all reuse the existing selection path.
const SOURCES = [
  { id: "github", label: "GitHub", icon: Github, hint: "A repository carrying token/theme CSS" },
  { id: "npm", label: "npm", icon: Package, hint: "A token or CSS package (not components)" },
  { id: "files", label: "Paste files", icon: FileText, hint: "Paste tokens.css, theme, stories…" },
];

export default function DesignSystemImport({ projectId, onImported, onClose }) {
  const [source, setSource] = useState("files");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [importName, setImportName] = useState("");
  const [pasted, setPasted] = useState("");
  const [pastedName, setPastedName] = useState("tokens.css");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const import_ = async () => {
    setLoading(true);
    setError(null);
    const payload = { project_id: projectId, source, name: importName || undefined };
    if (source === "github") { payload.repo = repo; payload.ref = ref || undefined; payload.subdirectory = subdirectory || undefined; }
    if (source === "npm") { payload.package = pkg; payload.version = version || undefined; }
    if (source === "files") {
      payload.name = importName || "Pasted design system";
      payload.entries = [{ path: pastedName || "tokens.css", content: pasted }];
    }
    try {
      const res = await base44.functions.invoke("designSystemImport", payload);
      setDone(res.data);
      onImported({ id: res.data.design_system_id, name: res.data.name });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const input = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] outline-none focus:ring-2 focus:ring-ring/40";
  const canSubmit =
    (source === "github" && repo.trim()) ||
    (source === "npm" && pkg.trim()) ||
    (source === "files" && pasted.trim());

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}>
      <div className="w-full max-w-md rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold">Import your design system</div>
            <div className="text-[11px] text-muted-foreground">Tokens, usage and examples — applies to new Builds only</div>
          </div>
          <button onClick={onClose} disabled={loading} className="rounded-md p-1 text-muted-foreground hover:bg-accent/60 transition-colors" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-1 px-4 pt-3">
          {SOURCES.map((s) => (
            <button key={s.id} onClick={() => { setSource(s.id); setError(null); }} disabled={loading}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${source === s.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"}`}>
              <s.icon className="h-3.5 w-3.5" /> {s.label}
            </button>
          ))}
        </div>
        <div className="px-4 pb-1 pt-1.5 text-[11px] text-muted-foreground">{SOURCES.find((s) => s.id === source)?.hint}</div>

        <div className="space-y-2.5 px-4 py-3">
          {source === "github" && (
            <>
              <input className={input} placeholder="owner/repository" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={loading} />
              <div className="flex gap-2">
                <input className={input} placeholder="Branch, tag or commit (optional)" value={ref} onChange={(e) => setRef(e.target.value)} disabled={loading} />
                <input className={input} placeholder="Subdirectory (optional)" value={subdirectory} onChange={(e) => setSubdirectory(e.target.value)} disabled={loading} />
              </div>
            </>
          )}
          {source === "npm" && (
            <div className="flex gap-2">
              <input className={input} placeholder="Package (e.g. open-props)" value={pkg} onChange={(e) => setPkg(e.target.value)} disabled={loading} />
              <input className={`${input} max-w-[110px]`} placeholder="Version (optional)" value={version} onChange={(e) => setVersion(e.target.value)} disabled={loading} />
            </div>
          )}
          {source === "files" && (
            <>
              <input className={input} placeholder="File name (e.g. tokens.css)" value={pastedName} onChange={(e) => setPastedName(e.target.value)} disabled={loading} />
              <textarea className={`${input} h-32 font-mono text-[11px]`} placeholder=":root { --color-primary: #4f46e5; --radius-lg: 0.75rem; }" value={pasted} onChange={(e) => setPasted(e.target.value)} disabled={loading} />
            </>
          )}
          <input className={input} placeholder="Name this design system (optional)" value={importName} onChange={(e) => setImportName(e.target.value)} disabled={loading} />

          {loading && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching and extracting design tokens…
            </div>
          )}
          {error && <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-[11.5px] text-destructive">{error}</div>}
          {done && (
            <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-2 text-[11.5px] text-emerald-600 dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" /> Imported — {done.applied_tokens} token(s) mapped, {done.reference_tokens} reference values. Selected for new Builds.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onClose} disabled={loading} className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-accent/60 transition-colors">Cancel</button>
          <button onClick={import_} disabled={loading || !canSubmit} className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-semibold text-background disabled:opacity-50 hover:opacity-90 transition-opacity">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Import
          </button>
        </div>
      </div>
    </div>
  );
}