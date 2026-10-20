import React, { useState } from "react";
import { Loader2, RefreshCw, Rocket } from "lucide-react";
import usePlanPrefill from "../usePlanPrefill";
import useCreatives from "../creatives/useCreatives";
import useLaunchReadiness from "./useLaunchReadiness";
import ReadinessItem from "./ReadinessItem";
import GoogleAdsLaunchDialog, { BLOCKER_TEXT } from "@/components/builder/GoogleAdsLaunchDialog";

const ZERNIO = ["Meta", "TikTok", "LinkedIn", "OpenAI"];

// Compact readiness for one brief. Brief/creative rows are informational; the launch button is
// gated ONLY by the server's launch_readiness result, and the launch dialog re-checks it.
export default function ReadinessPanel({ projectId, brief }) {
  const plan = usePlanPrefill(projectId, true);
  const { session } = useCreatives(projectId);
  const { loading, readiness, account, error, reload } = useLaunchReadiness(projectId, brief.landing_page);
  const [launchOpen, setLaunchOpen] = useState(false);
  const images = session?.status === "completed" ? session.images.length : 0;
  const gaps = [!brief.headlines.length && "headlines", !brief.descriptions.length && "descriptions", !brief.landing_page && "landing page", !brief.budget_micros && "daily budget"].filter(Boolean);

  return (
    <div className="mt-2 rounded-md border border-border bg-background p-2.5">
      <div className="flex items-center gap-2">
        <p className="text-[12px] font-medium text-foreground">Campaign readiness</p>
        <button type="button" onClick={reload} title="Re-check" className="ml-auto grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent"><RefreshCw className="h-3 w-3" /></button>
      </div>
      <ul>
        <ReadinessItem tone={plan ? "ok" : "off"} label={plan === undefined ? "Checking marketing plan…" : plan ? "Marketing plan found" : "No marketing plan"} detail={plan ? plan.goal : "Optional — a plan adds strategy context to generated copy."} />
        <ReadinessItem tone={gaps.length ? "warn" : "ok"} label={`Brief: ${brief.headlines.length} headlines, ${brief.descriptions.length} descriptions saved`} detail={gaps.length ? `Missing in brief: ${gaps.join(", ")}. Edit the brief to add them.` : "Brief copy is complete — this is not launch readiness."} />
        <ReadinessItem tone="off" label={images ? `${images} image preview(s)` : "No image previews"} detail="Previews only — no image is saved as an asset or attached to a campaign." />
      </ul>
      <p className="mt-2 text-[11px] font-medium text-foreground">Google Ads</p>
      {loading ? <div className="py-2"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        : error ? <p className="text-[11px] text-destructive">{error}</p>
        : (
          <ul>
            <ReadinessItem tone={account?.status === "active" ? "ok" : "off"} label={account ? `Account ${account.status}` : "No Google Ads account for this project"} detail={account ? null : "The account is created by the first launch."} />
            {readiness.blockers.map((b) => <ReadinessItem key={b} tone="warn" label={BLOCKER_TEXT[b] || b} detail={b} />)}
            {readiness.ready && <ReadinessItem tone="ok" label="Server launch checks passed" />}
          </ul>
        )}
      <p className="mt-1 text-[10.5px] text-muted-foreground">The existing launch creates a Performance Max campaign from the landing page and budget; it does not carry this brief's copy or images.</p>
      <button type="button" disabled={!readiness?.ready} onClick={() => setLaunchOpen(true)}
        className="mt-2 inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11.5px] text-primary-foreground disabled:opacity-40">
        <Rocket className="h-3 w-3" /> Launch on Google Ads…
      </button>
      <p className="mt-2 text-[11px] font-medium text-foreground">Zernio channels</p>
      <p className="text-[11px] text-muted-foreground">{ZERNIO.join(", ")}: launch unavailable — campaign creation through Zernio is not verified. Connecting an account does not make a campaign launch-ready.</p>
      <GoogleAdsLaunchDialog projectId={projectId} open={launchOpen} onOpenChange={setLaunchOpen} onLaunched={reload} />
    </div>
  );
}