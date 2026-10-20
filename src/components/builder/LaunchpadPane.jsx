import React, { useCallback, useEffect, useState } from "react";
import {
  Loader2, Megaphone, Pencil, X, Rocket, CheckCircle2, AlertTriangle, Upload,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Image } from "@/components/ui/image";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const MAX_MEDIA = 5;
const MAX_CATEGORIES = 3;
const MAX_TAGLINE = 200;
const MAX_DESCRIPTION = 4000;

const FRIENDLY = {
  NOT_LIVE_IN_PRODUCTION: "This project isn't live in production yet — publish to production first.",
  TERMS_REQUIRED: "Accept the submission terms to continue.",
  TAGLINE_TOO_LONG: `Tagline must be at most ${MAX_TAGLINE} characters.`,
  DESCRIPTION_TOO_LONG: `Description must be at most ${MAX_DESCRIPTION} characters.`,
  TOO_MANY_CATEGORIES: `At most ${MAX_CATEGORIES} categories.`,
  CATEGORIES_REQUIRED: "At least one category is required.",
  TOO_MANY_MEDIA: `At most ${MAX_MEDIA} media items.`,
  SCREENSHOT_TOO_SMALL: "Screenshots must be at least 1280x720 pixels.",
  UNSUPPORTED_SCREENSHOT: "Screenshots must be PNG, JPEG or WebP.",
  UNSUPPORTED_VIDEO: "Videos must be MP4 or WebM.",
  VIDEO_TOO_LARGE: "Videos must be at most 50 MB.",
  VIDEO_SIZE_UNKNOWN: "The video size could not be verified — try re-uploading it.",
  MEDIA_UNREACHABLE: "A media file could not be fetched — try re-uploading it.",
  MEDIA_URL_FORBIDDEN: "One of the media URLs is not allowed.",
  ALREADY_WITHDRAWN: "This submission was already withdrawn.",
  SUBMISSION_NOT_FOUND: "Submission not found.",
  NOT_A_MEMBER: "You don't have access to this project.",
};

const parseCategories = (raw) =>
  String(raw || "").split(",").map((c) => c.trim()).filter(Boolean).slice(0, MAX_CATEGORIES);

const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

export default function LaunchpadPane({ projectId, onCenterView }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [media, setMedia] = useState([]);
  const [terms, setTerms] = useState(false);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState(null);

  const active = submissions.find((s) => s.status === "submitted") || null;

  const load = useCallback(async () => {
    try {
      const res = await base44.functions.invoke("launchpadSubmission", { action: "my_submissions", project_id: projectId });
      setSubmissions(res.data?.submissions || []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const openForm = (row) => {
    setEditingId(row ? row.submission_id : null);
    setTagline(row?.tagline || "");
    setDescription(row?.description || "");
    setCategories((row?.categories || []).join(", "));
    setMedia((row?.media || []).map((m, i) => ({ id: `m${i}`, name: m.kind, kind: m.kind, file: null, uploading: false, url: m.url, error: null })));
    setTerms(Boolean(row?.terms_accepted_at));
    setFormError(null);
    setFormOpen(true);
  };
  const closeForm = () => { setFormOpen(false); setEditingId(null); setFormError(null); };

  const onPick = async (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = null;
    const room = MAX_MEDIA - media.filter((m) => !m.error).length;
    if (room <= 0) {
      setFormError({ code: "TOO_MANY_MEDIA", detail: `At most ${MAX_MEDIA} media items` });
      return;
    }
    const staged = picked.slice(0, room).map((file, i) => ({
      id: `${Date.now()}-${i}`, name: file.name, file,
      kind: file.type.startsWith("video/") ? "video" : "screenshot",
      uploading: true, url: null, error: null,
    }));
    setMedia((prev) => [...prev, ...staged]);
    for (const item of staged) {
      try {
        const { file_url } = await base44.integrations.Core.UploadPublicFile({ file: item.file });
        setMedia((prev) => prev.map((m) => (m.id === item.id ? { ...m, uploading: false, url: file_url } : m)));
      } catch (err) {
        setMedia((prev) => prev.map((m) => (m.id === item.id ? { ...m, uploading: false, error: err.message || "Upload failed" } : m)));
      }
    }
  };
  const removeMedia = (mid) => setMedia((prev) => prev.filter((m) => m.id !== mid));

  const save = async () => {
    if (saving) return;
    if (!terms) { setFormError({ code: "TERMS_REQUIRED", detail: "Accept the submission terms first" }); return; }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        project_id: projectId,
        tagline, description,
        categories: parseCategories(categories),
        media: media.filter((m) => m.url).map(({ url, kind }) => ({ url, kind })),
        terms_accepted: terms,
      };
      if (editingId) {
        await base44.functions.invoke("launchpadSubmission", { action: "edit", ...payload, submission_id: editingId });
        toast({ title: "Submission updated" });
      } else {
        const res = await base44.functions.invoke("launchpadSubmission", { action: "submit", ...payload });
        toast({ title: res.data?.duplicate ? "Already submitted" : "Submitted to Launchpad" });
      }
      closeForm();
      await load();
    } catch (e) {
      const code = e.response?.data?.code || null;
      const detail = e.response?.data?.error || e.message;
      setFormError({ code, detail });
      if (code === "NOT_LIVE_IN_PRODUCTION") toast({ variant: "destructive", title: "Not eligible", description: FRIENDLY[code] });
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (row) => {
    try {
      const res = await base44.functions.invoke("launchpadSubmission", { action: "withdraw", project_id: projectId, submission_id: row.submission_id });
      toast({ title: res.data?.duplicate ? "Already withdrawn" : "Submission withdrawn" });
      closeForm();
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Withdraw failed", description: e.response?.data?.error || e.message });
    } finally {
      setWithdrawingId(null);
    }
  };

  if (loading) {
    return <div className="p-5 text-[12px] text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading Launchpad status…</div>;
  }
  if (loadError) {
    return (
      <div className="p-5">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      </div>
    );
  }

  const badMedia = media.some((m) => m.error || m.uploading);

  return (
    <div className="h-full overflow-auto p-5 scrollbar-thin">
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-[13px] font-semibold tracking-tight">Launchpad</h3>
          {active ? (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />Submitted
            </span>
          ) : (
            <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Not submitted</span>
          )}
        </div>

        {active && !formOpen && (
          <div className="rounded-lg border border-border p-3 space-y-1.5">
            <p className="text-[13px] font-medium">{active.tagline}</p>
            <p className="text-[12px] text-muted-foreground line-clamp-3">{active.description}</p>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {(active.categories || []).map((c) => (
                <span key={c} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{c}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1.5">
              <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => openForm(active)}>
                <Pencil className="h-3 w-3" />Edit
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[12px] text-destructive hover:text-destructive" onClick={() => setWithdrawingId(active)}>
                Withdraw
              </Button>
            </div>
          </div>
        )}

        {formOpen && (
          <div className="rounded-lg border border-border p-3 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-medium">
              <Rocket className="h-3.5 w-3.5 text-muted-foreground" />
              {editingId ? "Edit submission" : "Submit your app"}
              <button onClick={closeForm} aria-label="Close form" className="ml-auto grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {formError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-[12px] text-destructive flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{FRIENDLY[formError.code] || formError.detail}
                  {FRIENDLY[formError.code] && formError.code !== "NOT_LIVE_IN_PRODUCTION" ? ` (${formError.detail})` : ""}
                  {formError.code === "NOT_LIVE_IN_PRODUCTION" && onCenterView ? " " : ""}
                </span>
                {formError.code === "NOT_LIVE_IN_PRODUCTION" && onCenterView && (
                  <button onClick={() => onCenterView("deploy")} className="ml-auto shrink-0 underline underline-offset-2 font-medium">Go to Deploy</button>
                )}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-[11.5px] font-medium text-muted-foreground">Tagline</label>
              <Input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={MAX_TAGLINE} placeholder="One line that sells the app" className="h-8 text-[12.5px]" />
              <p className="text-[10.5px] text-muted-foreground/60 text-right">{tagline.length}/{MAX_TAGLINE}</p>
            </div>
            <div className="space-y-1">
              <label className="text-[11.5px] font-medium text-muted-foreground">Description</label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={MAX_DESCRIPTION} rows={5} placeholder="What the app does and why people should try it" className="text-[12.5px]" />
              <p className="text-[10.5px] text-muted-foreground/60 text-right">{description.length}/{MAX_DESCRIPTION}</p>
            </div>
            <div className="space-y-1">
              <label className="text-[11.5px] font-medium text-muted-foreground">Categories (up to {MAX_CATEGORIES}, comma-separated)</label>
              <Input value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="productivity, tools, ai" className="h-8 text-[12.5px]" />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11.5px] font-medium text-muted-foreground">Showcase media (up to {MAX_MEDIA})</label>
              {media.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {media.map((m) => (
                    <div key={m.id} className="relative h-16 w-24 rounded-md border border-border overflow-hidden bg-muted/40 group">
                      {m.kind === "screenshot" && m.url && <Image src={m.url} fittingType="fit" className="h-full w-full" />}
                      {m.uploading && <div className="absolute inset-0 grid place-items-center bg-background/70"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>}
                      {m.error && <div className="absolute inset-0 grid place-items-center bg-background/80 p-1 text-[9.5px] text-destructive text-center">{m.error}</div>}
                      {!m.uploading && !m.error && (
                        <button onClick={() => removeMedia(m.id)} aria-label={`Remove ${m.name}`} className="absolute top-0.5 right-0.5 grid h-5 w-5 place-items-center rounded-full bg-background/90 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity">
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {media.length < MAX_MEDIA && (
                <label className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/60 cursor-pointer transition-colors">
                  <Upload className="h-3.5 w-3.5" />Upload screenshot or video
                  <input type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" className="hidden" onChange={onPick} />
                </label>
              )}
              <p className="text-[10.5px] text-muted-foreground/60">Screenshots PNG/JPEG/WebP ≥1280x720 · videos MP4/WebM ≤50 MB · validated on the server</p>
            </div>

            <label className="flex items-start gap-2 text-[12px] cursor-pointer">
              <Checkbox checked={terms} onCheckedChange={(v) => setTerms(v === true)} className="mt-0.5" />
              <span>I accept the Launchpad submission terms</span>
            </label>

            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-[12px]" onClick={save} disabled={saving || badMedia || !terms}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
                {editingId ? "Save changes" : "Submit your app"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={closeForm} disabled={saving}>Cancel</Button>
            </div>
          </div>
        )}

        {!active && !formOpen && (
          <Button size="sm" className="h-8 text-[12.5px]" onClick={() => openForm(null)}>
            <Rocket className="h-3.5 w-3.5" />Submit your app
          </Button>
        )}

        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">My submissions</h4>
          <div className="mt-2 space-y-1.5">
            {!submissions.length && <p className="text-[12px] text-muted-foreground/60">No submissions yet.</p>}
            {submissions.map((s) => (
              <div key={s.submission_id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
                <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${s.status === "submitted" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                  {s.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.tagline}</span>
                <span className="shrink-0 text-[10.5px] text-muted-foreground/60">{fmtDate(s.submitted_at || s.created_date)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <AlertDialog open={!!withdrawingId} onOpenChange={(o) => !o && setWithdrawingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this submission?</AlertDialogTitle>
            <AlertDialogDescription>
              The submission is removed from active listings. The project and its data are not touched — you can submit again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => withdrawingId && withdraw(withdrawingId)}>Withdraw</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}