import React, { useCallback, useEffect, useState } from "react";
import { Loader2, CheckCircle2, Circle, Rocket, Upload, RefreshCw, Download, Play, Undo2, X } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Non-terminal store submission statuses (cancel_submission is only valid before the upload is
// past the point of no return). Terminal set per the backend's MOBILE_STORE_TERMINAL.
const SUBMISSION_TERMINAL = ["SUBMITTED", "RELEASED", "FAILED", "CANCELLED"];

const PLATFORMS = [
  { id: "ios", label: "iOS — App Store" },
  { id: "android", label: "Android — Google Play" },
];

// The Publish panel's Mobile tab: "Prepare for App Store and Google Play Submission".
// Three steps, all wired to the EXISTING mobile control plane (no mobile logic recreated):
//   1. Check Your App — live production deployment, signing credentials, store connections
//   2. Build Stores Files — request a native package of the live artifact, then cut a release
//   3. Submit Your App — create the store submission from a READY release
function SectionHeading({ children }) {
  return <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h4>;
}

function CheckRow({ ok, muted, children }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[12px]">
      {ok === null ? <Circle className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" /> : ok
        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
        : <Circle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
      <span className={muted ? "text-muted-foreground" : ""}>{children}</span>
    </div>
  );
}

export default function MobilePublishTab({ project, live }) {
  const [platform, setPlatform] = useState("android");
  const [creds, setCreds] = useState(undefined); // undefined = loading, false = restricted
  const [conns, setConns] = useState(undefined);
  const [releases, setReleases] = useState(undefined);
  const [submissions, setSubmissions] = useState(undefined);
  const [working, setWorking] = useState(false);
  const [buildId, setBuildId] = useState("");
  const [versionName, setVersionName] = useState("");
  const [versionCode, setVersionCode] = useState("");

  const wsId = project?.workspace_id;
  const prod = live?.production || null;

  const load = useCallback(async () => {
    if (!wsId || !project?.id) return;
    const safe = (p) => p.catch(() => null);
    const [c, s, r, m] = await Promise.all([
      safe(base44.functions.invoke("mobileBuild", { action: "list_signing_credentials", workspace_id: wsId })),
      safe(base44.functions.invoke("mobileStore", { action: "list_store_connections", workspace_id: wsId })),
      safe(base44.functions.invoke("mobileBuild", { action: "list_releases", project_id: project.id })),
      safe(base44.functions.invoke("mobileStore", { action: "list_submissions", project_id: project.id })),
    ]);
    setCreds(c ? c.data?.credentials ?? [] : false);
    setConns(s ? s.data?.connections ?? [] : false);
    setReleases(r ? r.data?.releases ?? [] : false);
    setSubmissions(m ? m.data?.submissions ?? [] : false);
  }, [wsId, project?.id]);

  useEffect(() => { load(); }, [load]);

  const credFor = (p) => (Array.isArray(creds) ? creds.find((c) => String(c.platform) === p && c.present !== false) : null);
  const connFor = (p) => (Array.isArray(conns) ? conns.find((c) => String(c.platform) === p && c.configured !== false && c.present !== false) : null);
  const input = "rounded-md border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:ring-1 ring-ring";

  const requestBuild = async () => {
    if (!prod || working) return;
    setWorking(true);
    try {
      const res = await base44.functions.invoke("mobileBuild", { action: "create", project_id: project.id, deployment_id: prod.id, platform });
      setBuildId(res.data?.build_id || "");
      toast({ title: "Native build queued", description: "Packaging the live artifact in the background — builds are pinned to the deployed version." });
    } catch (e) {
      const bid = e.response?.data?.build_id;
      if (bid) {
        setBuildId(bid);
        toast({ title: "Build already exists", description: "Reusing the existing package for this deployment and platform." });
      } else {
        toast({ variant: "destructive", title: "Build could not start", description: e.response?.data?.error || e.message });
      }
    } finally { setWorking(false); }
  };

  const createRelease = async () => {
    const bid = buildId.trim();
    if (!bid || working) return;
    setWorking(true);
    try {
      await base44.functions.invoke("mobileBuild", {
        action: "create_release", build_id: bid,
        version_name: versionName.trim() || undefined,
        version_code: versionCode ? Number(versionCode) : undefined,
      });
      toast({ title: "Release created", description: "The package checksum is verified before the release can be submitted." });
      setBuildId(""); setVersionName(""); setVersionCode("");
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Release not created", description: e.response?.data?.error || e.message });
    } finally { setWorking(false); }
  };

  const submit = async (releaseId) => {
    if (working) return;
    setWorking(true);
    try {
      const res = await base44.functions.invoke("mobileStore", { action: "create_submission", release_id: releaseId });
      toast({ title: "Submission created", description: "The store upload runs in the background with durable retries." });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Submission not created", description: e.response?.data?.error || e.message });
    } finally { setWorking(false); }
  };

  // Release lifecycle — the existing ready/publish/rollback transitions. Each is gated by the
  // release's current status (DRAFT→READY→RELEASED→ROLLED_BACK), exactly as the backend enforces.
  const lifecycle = async (releaseId, action) => {
    if (working) return;
    setWorking(true);
    try {
      await base44.functions.invoke("mobileBuild", { action, release_id: releaseId });
      toast({ title: `Release ${action.replace("_release", "")}` });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Action failed", description: e.response?.data?.error || e.message });
    } finally { setWorking(false); }
  };

  const download = async (buildId) => {
    if (working || !buildId) return;
    setWorking(true);
    try {
      const res = await base44.functions.invoke("mobileBuild", { action: "download_url", build_id: buildId });
      const url = res.data?.url || res.data?.download_url;
      if (url) { window.open(url, "_blank"); toast({ title: "Download opened", description: "A short-lived signed URL for the build artifact." }); }
      else toast({ variant: "destructive", title: "No download URL returned" });
    } catch (e) {
      toast({ variant: "destructive", title: "Download failed", description: e.response?.data?.error || e.message });
    } finally { setWorking(false); }
  };

  const cancelSubmission = async (submissionId) => {
    if (working) return;
    if (!confirm("Cancel this store submission?")) return;
    setWorking(true);
    try {
      await base44.functions.invoke("mobileStore", { action: "cancel_submission", submission_id: submissionId });
      toast({ title: "Submission cancelled" });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Cancel failed", description: e.response?.data?.error || e.message });
    } finally { setWorking(false); }
  };

  const readyReleases = (Array.isArray(releases) ? releases : []).filter((r) => r.status === "READY");
  const hasSubmission = Array.isArray(submissions) && submissions.length > 0;

  return (
    <div className="space-y-4 p-4">
      <SectionHeading>Prepare for App Store and Google Play Submission</SectionHeading>

      {/* Step 1 — Check Your App */}
      <section className="rounded-lg border border-border p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="grid place-items-center h-5 w-5 rounded-full bg-foreground text-background text-[10.5px] font-semibold">1</span>
          <span className="text-[12.5px] font-semibold">Check Your App</span>
          <button onClick={load} className="ml-auto flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground transition-colors" aria-label="Refresh checks">
            <RefreshCw className="h-3 w-3" />Refresh
          </button>
        </div>
        <CheckRow ok={!!prod}>
          {prod ? "Live production deployment — v" + prod.version_number : "No live production deployment — publish the web app first"}
        </CheckRow>
        {creds === undefined ? (
          <div className="py-1 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
        ) : creds === false ? (
          <CheckRow ok={false} muted>Signing credentials — restricted (owner/admin manages them in workspace secrets)</CheckRow>
        ) : (
          PLATFORMS.map((p) => (
            <CheckRow key={p.id} ok={!!credFor(p.id)}>
              {"Signing credentials (" + p.label.split(" — ")[0] + ") — " + (credFor(p.id) ? "configured" : "not configured")}
            </CheckRow>
          ))
        )}
        {conns !== undefined && conns !== false && PLATFORMS.map((p) => (
          <CheckRow key={p.id} ok={!!connFor(p.id)}>
            {"Store connection (" + p.label.split(" — ")[1] + ") — " + (connFor(p.id) ? "configured" : "not configured")}
          </CheckRow>
        ))}
      </section>

      {/* Step 2 — Build Stores Files */}
      <section className="rounded-lg border border-border p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="grid place-items-center h-5 w-5 rounded-full bg-foreground text-background text-[10.5px] font-semibold">2</span>
          <span className="text-[12.5px] font-semibold">Build Stores Files</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform" className={input}>
            {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <button
            onClick={requestBuild}
            disabled={!prod || working}
            title={prod ? "Package the live artifact" : "Requires a live production deployment"}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium hover:bg-muted disabled:opacity-50 transition-colors"
          >
            {working ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}Build package
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input value={buildId} onChange={(e) => setBuildId(e.target.value)} placeholder="build id" className={input + " font-mono w-40"} aria-label="Build id" />
          <input value={versionName} onChange={(e) => setVersionName(e.target.value)} placeholder="version, e.g. 1.0.0" className={input + " w-36"} aria-label="Version name" />
          <input value={versionCode} onChange={(e) => setVersionCode(e.target.value.replace(/[^0-9]/g, ""))} placeholder="version code" className={input + " font-mono w-28"} aria-label="Version code" inputMode="numeric" />
          <button
            onClick={createRelease}
            disabled={!buildId.trim() || working}
            title="Create a release from the finished build"
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium hover:bg-muted disabled:opacity-50 transition-colors"
          >
            <Upload className="h-3 w-3" />Create release
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          A release can be cut once the background build finishes — its package is checksum-verified before anything is submitted.
        </p>
        {Array.isArray(releases) && releases.length > 0 && (
          <div className="mt-2 divide-y divide-border rounded-md border border-border">
            {releases.slice(0, 5).map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px]">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{r.platform}</span>
                <span className="font-mono">{r.version_name || "v" + (r.version_code || "—")}</span>
                <span className={"font-mono text-[10.5px] " + (r.status === "READY" || r.status === "RELEASED" ? "text-emerald-600" : r.status === "DRAFT" ? "text-amber-600" : "text-muted-foreground")}>{r.status}</span>
                {r.status === "READY" && (
                  <button onClick={() => submit(r.id)} disabled={working} className="rounded-md border border-border px-2 py-0.5 text-[10.5px] font-medium hover:bg-muted disabled:opacity-50 transition-colors">
                    Submit to store
                  </button>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                  {r.status === "DRAFT" && (
                    <button onClick={() => lifecycle(r.id, "ready_release")} disabled={working} title="Mark ready" className="rounded p-1 text-muted-foreground hover:text-emerald-600 hover:bg-muted disabled:opacity-50 transition-colors"><Play className="h-3 w-3" /></button>
                  )}
                  {r.status === "READY" && (
                    <button onClick={() => lifecycle(r.id, "publish_release")} disabled={working} title="Release" className="rounded p-1 text-muted-foreground hover:text-emerald-600 hover:bg-muted disabled:opacity-50 transition-colors"><Rocket className="h-3 w-3" /></button>
                  )}
                  {r.status === "RELEASED" && (
                    <button onClick={() => lifecycle(r.id, "rollback_release")} disabled={working} title="Rollback" className="rounded p-1 text-muted-foreground hover:text-amber-600 hover:bg-muted disabled:opacity-50 transition-colors"><Undo2 className="h-3 w-3" /></button>
                  )}
                  <button onClick={() => download(r.mobile_build_id)} disabled={working || !r.mobile_build_id} title="Download artifact" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors"><Download className="h-3 w-3" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Step 3 — Submit Your App */}
      <section className="rounded-lg border border-border p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="grid place-items-center h-5 w-5 rounded-full bg-foreground text-background text-[10.5px] font-semibold">3</span>
          <span className="text-[12.5px] font-semibold">Submit Your App</span>
          {hasSubmission && <span className="ml-auto text-[10.5px] text-emerald-600">{submissions.length} submission(s)</span>}
        </div>
        {submissions === undefined ? (
          <div className="py-1 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
        ) : !Array.isArray(submissions) ? (
          <p className="text-[11.5px] text-muted-foreground/70">Submission history is restricted for your role.</p>
        ) : submissions.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground/70">No store submissions yet — submit a READY release above.</p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {submissions.slice(0, 5).map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px]">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{s.store || s.platform}</span>
                <span className="font-mono">{s.version_name || "—"}</span>
                <span className={"font-mono text-[10.5px] " + (s.status === "SUBMITTED" || s.status === "RELEASED" ? "text-emerald-600" : s.status === "FAILED" ? "text-destructive" : "text-muted-foreground")}>{s.status}</span>
                {!SUBMISSION_TERMINAL.includes(s.status) && (
                  <button onClick={() => cancelSubmission(s.id)} disabled={working} title="Cancel submission" className="ml-auto rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors"><X className="h-3 w-3" /></button>
                )}
                {s.failure_message && <span className="ml-auto text-[10px] text-destructive truncate" title={s.failure_message}>{s.failure_code || "failed"}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}