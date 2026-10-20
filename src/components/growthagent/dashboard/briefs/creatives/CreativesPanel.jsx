import React, { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import useCreatives from "./useCreatives";
import TextVariant from "./TextVariant";
import ImageVariants from "./ImageVariants";
import AcceptCreativesDialog from "./AcceptCreativesDialog";

const TARGET = { HEADLINE: "headlines", DESCRIPTION: "descriptions" };

// Selected copy is saved INTO the brief (existing brief_update). It is not campaign-ready or
// published: attaching assets to a live campaign is the provider-gated accept step, not used here.
export default function CreativesPanel({ projectId, brief, onSave }) {
  const { session, loading, generating, error, generate } = useCreatives(projectId);
  const [edits, setEdits] = useState({});
  const [picked, setPicked] = useState({});
  const [confirm, setConfirm] = useState(false);
  const [saveError, setSaveError] = useState("");
  const text = session?.status === "completed" ? session.text : [];
  const valueOf = (l) => edits[l.session_asset_id] ?? l.content;
  const chosen = text.filter((l) => picked[l.session_asset_id] && TARGET[l.asset_field_type] && valueOf(l).trim());
  const pick = (type) => chosen.filter((l) => l.asset_field_type === type).map((l) => valueOf(l).trim());

  const save = async () => {
    setSaveError("");
    const merge = (cur, add) => [...new Set([...cur, ...add])].slice(0, 20);
    try {
      await onSave(brief.id, { headlines: merge(brief.headlines, pick("HEADLINE")), descriptions: merge(brief.descriptions, pick("DESCRIPTION")) });
      setPicked({});
    } catch (e) { setSaveError(e.message); }
  };

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-background p-2.5">
      <div className="flex items-center gap-2">
        <p className="text-[12px] font-medium text-foreground">Creatives</p>
        <span className="text-[10.5px] text-muted-foreground">Selections are saved to the brief only — not campaign-ready or published.</span>
        <button type="button" disabled={generating || loading} onClick={() => generate(brief)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11.5px] text-foreground hover:bg-accent disabled:opacity-50">
          {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}{session ? "Regenerate" : "Generate"}
        </button>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      {loading ? <div className="grid place-items-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        : generating ? <p className="text-[11px] text-muted-foreground">Generating copy and images — this can take a minute.</p>
        : !session ? <p className="text-[11px] text-muted-foreground">No creatives yet. Generate copy and image variants from this brief.</p>
        : session.status === "failed" ? <p className="text-[11px] text-destructive">Generation failed: {session.error || "unknown error"}</p>
        : session.status === "generating" ? <p className="text-[11px] text-muted-foreground">A generation is still running. Refresh in a moment.</p>
        : (
          <>
            {text.length ? (
              <ul>
                {text.map((l) => {
                  const v = valueOf(l);
                  const target = TARGET[l.asset_field_type];
                  return <TextVariant key={l.session_asset_id} type={l.asset_field_type} value={v} selectable={!!target}
                    selected={!!picked[l.session_asset_id]} inBrief={!!target && brief[target].includes(v.trim())}
                    onToggle={() => setPicked({ ...picked, [l.session_asset_id]: !picked[l.session_asset_id] })}
                    onChange={(nv) => setEdits({ ...edits, [l.session_asset_id]: nv })} />;
                })}
              </ul>
            ) : <p className="text-[11px] text-muted-foreground">No copy was generated.</p>}
            <ImageVariants images={session.images} backgroundCount={session.background_image_count} />
            <div className="flex items-center gap-2">
              {saveError && <p className="text-[11px] text-destructive">{saveError}</p>}
              <button type="button" disabled={!chosen.length} onClick={() => setConfirm(true)}
                className="ml-auto rounded-md bg-primary px-2.5 py-1 text-[11.5px] text-primary-foreground disabled:opacity-40">
                Save {chosen.length || ""} selected
              </button>
            </div>
          </>
        )}
      <AcceptCreativesDialog open={confirm} onOpenChange={setConfirm} headlines={pick("HEADLINE")} descriptions={pick("DESCRIPTION")} onConfirm={save} />
    </div>
  );
}