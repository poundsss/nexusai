import React, { useState } from "react";
import { X, Globe, Copy, Check, Loader2, ShieldCheck, Rocket, Pencil, Plus, Star } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import MobilePublishTab from "./MobilePublishTab";

// Base44-style publish panel. Web tab: public address, custom domains, sharing, security
// and publish status. Mobile tab: App Store / Google Play preparation. Everything routes
// through the EXISTING deploy, domain, security-scan and mobile contracts — publishing
// stays an explicit user action.
function Heading({ children }) {
  return <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h4>;
}

export default function PublishModal({ project, versions, live, liveUrl, domains, working, onDeploy, onClose, onView }) {
  const [tab, setTab] = useState("web");
  const [copied, setCopied] = useState(false);
  const [visibility, setVisibility] = useState("link");
  const [scan, setScan] = useState(null);
  const [hostname, setHostname] = useState("");
  const [adding, setAdding] = useState(false);

  const prod = live?.production || null;
  const latestV = versions[0]?.number || project?.version_count || 0;
  const publicUrl = prod?.deployment_url ? window.location.origin + prod.deployment_url : (project?.slug ? window.location.origin + "/app/" + project.slug : null);
  const upToDate = prod?.version_number === latestV;
  const btn = "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors";

  const copy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Select and copy the address manually." });
    }
  };

  const addDomain = async () => {
    const h = hostname.trim();
    if (!h || adding) return;
    setAdding(true);
    try {
      await domains.add(h, "production");
      setHostname("");
      toast({ title: "Domain added", description: "It serves traffic only after real DNS TXT verification." });
    } catch (e) {
      toast({ variant: "destructive", title: "Domain could not be added", description: e.response?.data?.error || e.message });
    } finally { setAdding(false); }
  };

  const runScan = async () => {
    setScan({ running: true });
    try {
      const res = await base44.functions.invoke("securityCertificationTest", {});
      setScan({ running: false, ok: res.data?.ok, passed: res.data?.passed, failed: res.data?.failed });
    } catch (e) {
      setScan({ running: false, error: e.response?.data?.error || e.message });
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-hidden rounded-lg border border-border bg-background shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-border px-4 py-3">
          <Rocket className="h-4 w-4 text-muted-foreground" />
          <h3 className="ml-2 font-semibold text-[13px]">Publish</h3>
          <button onClick={onClose} className="ml-auto grid place-items-center h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-0.5 border-b border-border px-4 py-2">
          {["web", "mobile"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={"rounded-md px-3 py-1 text-[12px] font-medium transition-colors " + (tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {t === "web" ? "Web" : "Mobile app"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto scrollbar-thin">
          {tab === "web" ? (
            <div className="space-y-4 p-4">
              {/* Public URL */}
              <section>
                <Heading>Web app</Heading>
                {prod && publicUrl ? (
                  <div className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <a href={publicUrl} target="_blank" rel="noreferrer" title="Open the published app" className="min-w-0 flex-1 truncate font-mono text-[12px] text-blue-600 hover:underline">
                      {publicUrl}
                    </a>
                    <button onClick={copy} className="grid place-items-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" aria-label="Copy public URL" title="Copy">
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button onClick={() => { onView("deploy"); onClose(); }} className={btn}>
                      <Pencil className="h-3 w-3" />Edit domain
                    </button>
                  </div>
                ) : (
                  <p className="mt-1.5 text-[12px] text-muted-foreground">
                    {"Not published yet — the first publish makes it reachable at /app/" + (project?.slug || "…") + "."}
                  </p>
                )}
              </section>

              {/* Custom domains */}
              <section>
                <Heading>Custom domain</Heading>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value)}
                    placeholder="app.yourdomain.com"
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 ring-ring"
                    aria-label="Custom domain"
                  />
                  <button onClick={addDomain} disabled={!hostname.trim() || adding || domains.working} className={btn + " disabled:opacity-50"}>
                    {adding || domains.working ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}Add
                  </button>
                </div>
                {domains.loading ? (
                  <div className="mt-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
                ) : (domains.domains || []).length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground/70">No custom domains yet — a domain serves traffic only after real DNS TXT verification.</p>
                ) : (
                  <div className="mt-1.5 divide-y divide-border rounded-md border border-border">
                    {domains.domains.map((d) => (
                      <div key={d.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px]">
                        <span className="truncate font-mono">{d.hostname}</span>
                        {d.is_primary && <Star className="h-3 w-3 text-amber-500 shrink-0" />}
                        <span className={"ml-auto shrink-0 font-mono text-[10.5px] " + (d.status === "active" ? "text-emerald-600" : "text-muted-foreground")}>{d.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Share your app */}
              <section>
                <Heading>Share your app</Heading>
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  aria-label="App visibility"
                  className="mt-1.5 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
                >
                  <option value="link">Anyone with the link — open access</option>
                  <option value="private">Private data — each user sees only their records</option>
                </select>
                {visibility === "private" && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground/80">
                    Per-user data isolation is configured on your data models.
                    <button onClick={() => { onView("data"); onClose(); }} className="ml-1 underline underline-offset-2 hover:text-foreground">Open the Data pane</button>
                  </p>
                )}
              </section>

              {/* Security */}
              <section>
                <Heading>Security</Heading>
                <div className="mt-1.5 flex items-center gap-2 text-[12px]">
                  <span className={"h-1.5 w-1.5 rounded-full " + (project?.rls_enabled ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                  <span className="text-muted-foreground">Row-level security</span>
                  <span className="font-medium">{project?.rls_enabled ? "enabled" : "off"}</span>
                  <span className="ml-4 text-muted-foreground/60">{"last build: " + (project?.last_build_status || "none")}</span>
                  <button onClick={runScan} disabled={scan?.running} className={btn + " ml-auto shrink-0 disabled:opacity-50"}>
                    {scan?.running ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}Run scan
                  </button>
                </div>
                {scan && !scan.running && (scan.error
                  ? <p className="mt-1 text-[11px] text-destructive">{scan.error}</p>
                  : <p className={"mt-1 text-[11px] " + (scan.ok ? "text-emerald-600" : "text-amber-600")}>
                      {scan.ok ? "Scan passed — " + scan.passed + " check(s)" : "Scan found " + (scan.failed ?? "?") + " issue(s)"}
                    </p>)}
              </section>

              {/* Publish status */}
              <section className="border-t border-border pt-3">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-muted-foreground">Production</span>
                  <span className="font-mono">{prod ? "v" + prod.version_number : "not deployed"}</span>
                  {!upToDate && <span className="text-muted-foreground/60">{"· latest is v" + latestV}</span>}
                  {upToDate && <span className="text-emerald-600">· up to date</span>}
                  <button
                    onClick={() => onDeploy("production")}
                    disabled={working}
                    className="ml-auto flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-semibold text-background hover:opacity-90 disabled:opacity-50 transition-opacity shrink-0"
                  >
                    {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                    {prod ? "Publish" : "Publish now"}
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <MobilePublishTab project={project} live={live} />
          )}
        </div>
      </div>
    </div>
  );
}