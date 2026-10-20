import React, { useState } from "react";
import { Loader2, Copy, Download, Pencil, Wand2, RefreshCw, RotateCcw, Check, X, Share2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Image } from "@/components/ui/image";

const PLATFORMS = [
  { id: "instagram", label: "Instagram" },
  { id: "x", label: "X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "tiktok", label: "TikTok" },
  { id: "facebook", label: "Facebook" },
  { id: "reddit", label: "Reddit" },
];
const MAX_PLATFORMS = 3;
const GOALS = ["Launch my app", "Grow signups", "Build in public", "Announce a new feature"];

export default function SocialContent({ projectId }) {
  const [goal, setGoal] = useState(null);
  const [audience, setAudience] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [selected, setSelected] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [posts, setPosts] = useState(null);
  const [activeTab, setActiveTab] = useState(null);
  const [editingKey, setEditingKey] = useState(null);
  const [editText, setEditText] = useState("");
  const [busyKey, setBusyKey] = useState(null);

  const togglePlatform = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= MAX_PLATFORMS ? s : [...s, id]));

  const generate = async () => {
    if (!goal || !audience.trim() || !selected.length || generating) return;
    setGenerating(true);
    try {
      const res = await base44.functions.invoke("socialContent", {
        action: "generate", project_id: projectId, goal, audience: audience.trim(),
        profile_url: profileUrl.trim(), platforms: selected,
      });
      setPosts(res.data.plan.posts);
      setActiveTab(res.data.plan.posts[0]?.platform || null);
    } catch (e) {
      toast({ variant: "destructive", title: "Generation failed", description: e.response?.data?.error || e.message });
    } finally {
      setGenerating(false);
    }
  };

  const startFresh = () => {
    setPosts(null); setActiveTab(null); setEditingKey(null); setEditText(null); setBusyKey(null);
  };

  const patchVariant = (pi, vi, patch) =>
    setPosts((prev) => prev.map((p, i) => (i !== pi ? p : { ...p, variants: p.variants.map((v, j) => (j !== vi ? v : { ...v, ...patch })) })));

  const saveEdit = (pi, vi) => {
    patchVariant(pi, vi, { copy: editText.trim() || undefined });
    setEditingKey(null);
  };

  const improveWithAI = async (pi, vi) => {
    const v = posts[pi].variants[vi];
    const key = `improve:${pi}:${vi}`;
    setBusyKey(key);
    try {
      const res = await base44.functions.invoke("socialContent", {
        action: "improve", project_id: projectId, platform: posts[pi].platform, copy: v.copy,
      });
      patchVariant(pi, vi, { copy: res.data.copy });
    } catch (e) {
      toast({ variant: "destructive", title: "Improve failed", description: e.response?.data?.error || e.message });
    } finally {
      setBusyKey(null);
    }
  };

  const regenerateImage = async (pi, vi) => {
    const v = posts[pi].variants[vi];
    const key = `image:${pi}:${vi}`;
    setBusyKey(key);
    try {
      const res = await base44.functions.invoke("socialContent", {
        action: "image", project_id: projectId, platform: posts[pi].platform,
        prompt: v.visual_prompt || `Clean promotional visual for a ${posts[pi].platform} post`,
      });
      patchVariant(pi, vi, { image_url: res.data.url, image_error: null });
    } catch (e) {
      toast({ variant: "destructive", title: "Image generation failed", description: e.response?.data?.error || e.message });
    } finally {
      setBusyKey(null);
    }
  };

  const copyPost = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Your browser blocked clipboard access." });
    }
  };

  const publishToLinkedIn = async (pi, vi) => {
    const v = posts[pi].variants[vi];
    const key = `publish:${pi}:${vi}`;
    setBusyKey(key);
    try {
      const res = await base44.functions.invoke("linkedinPublish", { project_id: projectId, copy: v.copy });
      toast({ title: "Published to LinkedIn", description: res.data.post_urn ? `Post ${res.data.post_urn} is live.` : "Your post is live." });
    } catch (e) {
      toast({ variant: "destructive", title: "Publish failed", description: e.response?.data?.error || e.message });
    } finally {
      setBusyKey(null);
    }
  };

  const downloadContent = async () => {
    const lines = ["Social content", `Goal: ${goal || "—"} · Audience: ${audience || "—"}`, ""];
    posts.forEach((p) => {
      lines.push(`== ${p.platform.toUpperCase()} ==`);
      p.variants.forEach((v, i) => {
        lines.push("", `- Variation ${i + 1} -`, v.copy, `Visual: ${v.visual_prompt || "—"}`, `Image: ${v.image_url || "n/a"}`);
      });
      lines.push("");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "social-content.txt";
    a.click();
    URL.revokeObjectURL(url);

    let downloaded = 0;
    let failed = 0;
    for (const p of posts) {
      for (let i = 0; i < p.variants.length; i++) {
        const imageUrl = p.variants[i].image_url;
        if (!imageUrl) continue;
        try {
          const res = await fetch(imageUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const imageBlob = await res.blob();
          const ext = (imageBlob.type || "image/png").replace("image/", "").split(";")[0] || "png";
          const objectUrl = URL.createObjectURL(imageBlob);
          const imgA = document.createElement("a");
          imgA.href = objectUrl;
          imgA.download = `social-content-${p.platform}-${i + 1}.${ext}`;
          imgA.click();
          URL.revokeObjectURL(objectUrl);
          downloaded++;
        } catch {
          failed++;
        }
      }
    }
    if (downloaded || failed) {
      toast({ title: `Downloaded ${downloaded} image${downloaded === 1 ? "" : "s"}`, ...(failed ? { description: `${failed} image${failed === 1 ? "" : "s"} could not be downloaded.` } : {}) });
    }
  };

  const setupReady = goal && audience.trim() && selected.length > 0;

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Social content</h3>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground/70">
            {posts ? "3 variations per platform — edit, improve, copy. No direct posting." : "Goal + audience → ready-to-post content for up to 3 platforms."}
          </p>
        </div>
        {posts && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button onClick={downloadContent} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:bg-muted/50 transition-colors">
              <Download className="h-3 w-3" /> Download content
            </button>
            <button onClick={startFresh} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-muted/50 transition-colors">
              <RotateCcw className="h-3 w-3" /> Start fresh
            </button>
          </div>
        )}
      </div>

      {!posts && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">Launch goal</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {GOALS.map((g) => (
                <button key={g} onClick={() => setGoal(g)}
                  className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${goal === g ? "border-foreground bg-foreground text-background font-medium" : "border-border text-muted-foreground hover:bg-muted/50"}`}>
                  {g}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Target audience</span>
              <input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. indie founders shipping their first product"
                className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] outline-none focus:ring-1 focus:ring-ring" />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Match your tone — profile link (optional)</span>
              <input value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder="https://x.com/yourhandle"
                className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] outline-none focus:ring-1 focus:ring-ring" />
            </label>
          </div>
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">Platforms — up to {MAX_PLATFORMS}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PLATFORMS.map((p) => {
                const on = selected.includes(p.id);
                const full = !on && selected.length >= MAX_PLATFORMS;
                return (
                  <button key={p.id} onClick={() => !full && togglePlatform(p.id)} disabled={full}
                    className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${on ? "border-brand bg-brand-muted text-foreground font-medium" : full ? "border-border text-muted-foreground/40 cursor-not-allowed" : "border-border text-muted-foreground hover:bg-muted/50"}`}>
                    {p.label}
                  </button>
                );
              })}
              <span className="self-center text-[11px] text-muted-foreground/60">{selected.length} of {MAX_PLATFORMS}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={generate} disabled={!setupReady || generating}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40 hover:opacity-90 transition-opacity">
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              Generate posts
            </button>
            {generating && <span className="text-[11px] text-muted-foreground">Writing copy and suggested visuals… this can take up to a minute.</span>}
          </div>
        </div>
      )}

      {posts && (
        <div className="border-t border-border">
          <div className="flex gap-1 border-b border-border px-3 pt-2">
            {posts.map((p) => (
              <button key={p.platform} onClick={() => setActiveTab(p.platform)}
                className={`rounded-t-md px-3 py-1.5 text-[12px] font-medium transition-colors ${activeTab === p.platform ? "border border-b-0 border-border bg-muted/50 text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {PLATFORMS.find((x) => x.id === p.platform)?.label || p.platform}
              </button>
            ))}
          </div>
          <div className="p-3 space-y-3">
            {(posts.find((p) => p.platform === activeTab) || posts[0])?.variants.map((v, vi) => {
              const pi = posts.findIndex((p) => p.platform === (activeTab || posts[0].platform));
              const editOpen = editingKey === `${pi}:${vi}`;
              const busy = busyKey !== null;
              const thisBusy = (k) => busyKey === `${k}:${pi}:${vi}`;
              return (
                <div key={vi} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Variation {vi + 1}</span>
                    {!editOpen && (
                      <button onClick={() => { setEditingKey(`${pi}:${vi}`); setEditText(v.copy); }}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:bg-muted/50 transition-colors">
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                    )}
                  </div>
                  {editOpen ? (
                    <div className="space-y-1.5">
                      <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={4}
                        className="w-full rounded-md border border-border bg-background p-2 text-[12.5px] outline-none focus:ring-1 focus:ring-ring" />
                      <div className="flex gap-1.5">
                        <button onClick={() => saveEdit(pi, vi)} className="inline-flex items-center gap-1 rounded-md bg-foreground text-background px-2 py-1 text-[11.5px] font-semibold">
                          <Check className="h-3 w-3" /> Save changes
                        </button>
                        <button onClick={() => setEditingKey(null)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground">
                          <X className="h-3 w-3" /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{v.copy}</p>
                  )}
                  {v.image_url && (
                    <Image src={v.image_url} alt={`Suggested visual for ${posts[pi].platform} variation ${vi + 1}`} fittingType="fit"
                      className="h-40 w-full rounded-md border border-border bg-muted/20" />
                  )}
                  {v.image_error && <p className="text-[11px] text-amber-600">{v.image_error}</p>}
                  {v.visual_prompt && <p className="font-mono text-[10.5px] text-muted-foreground/60">Visual: {v.visual_prompt}</p>}
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <button onClick={() => improveWithAI(pi, vi)} disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium disabled:opacity-40 hover:bg-muted/50 transition-colors">
                      {thisBusy("improve") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} Improve with AI
                    </button>
                    <button onClick={() => regenerateImage(pi, vi)} disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium disabled:opacity-40 hover:bg-muted/50 transition-colors">
                      {thisBusy("image") ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Regenerate image
                    </button>
                    <button onClick={() => copyPost(v.copy)}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:bg-muted/50 transition-colors">
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                    {posts[pi].platform === "linkedin" && (
                      <button onClick={() => publishToLinkedIn(pi, vi)} disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md border border-brand px-2 py-1 text-[11.5px] font-medium text-foreground disabled:opacity-40 hover:bg-brand-muted transition-colors">
                        {thisBusy("publish") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Share2 className="h-3 w-3" />} Publish to LinkedIn
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <p className="text-[10.5px] text-muted-foreground/50">
              LinkedIn variations publish directly through the connected LinkedIn account (text only — images are not posted). Other platforms: copy the text and post it yourself. Credits: plan 10 · Improve with AI 1 · Regenerate image 1 (integration credits).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}