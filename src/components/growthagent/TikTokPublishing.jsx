import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import TikTokPostForm from "@/components/growthagent/TikTokPostForm";
import useTikTokPublishing from "@/components/growthagent/useTikTokPublishing";

export default function TikTokPublishing({ projectId, onQueued }) {
  const state = useTikTokPublishing(projectId, onQueued);
  return <section className="my-5 rounded-xl border border-border bg-card p-4 text-card-foreground">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-semibold">TikTok video publishing</h3><p className="text-xs text-muted-foreground">Your own TikTok OAuth app. Existing read/list connections are unchanged.</p></div>
      <Button variant="outline" size="sm" onClick={state.load} disabled={state.busy}>Refresh</Button>
    </div>
    {state.error && <p role="alert" className="mb-3 text-sm text-destructive">{state.error}</p>}
    {state.notice && <p role="status" className="mb-3 text-sm">{state.notice}</p>}
    {!state.readiness ? (!state.error && <Loader2 className="h-4 w-4 animate-spin" />) : !state.readiness.configured ? <div className="space-y-2 text-xs text-muted-foreground">
      <p>Publishing is disabled until your TikTok app configuration is supplied through this project's existing Secrets settings.</p>
      <p>Missing: {state.readiness.missing_configuration.join(", ")}</p>
      <p>Register this site's static HTTPS /oauth/callback address with TikTok. Content Posting access must approve video.publish; public posting requires TikTok's audit.</p>
    </div> : <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={state.connect} disabled={state.busy}>Connect TikTok account</Button>
        {state.credentialId && <Button variant="ghost" size="sm" onClick={state.disconnect} disabled={state.busy}>Disconnect selected account</Button>}
      </div>
      {state.readiness.credentials.length > 0 && <label className="block text-xs">Your authorized account
        <select value={state.credentialId} onChange={(e) => state.setCredentialId(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2">
          {state.readiness.credentials.map((item) => <option key={item.credential_id} value={item.credential_id}>{item.external_subject}</option>)}
        </select>
      </label>}
      {state.creator ? <TikTokPostForm key={`${projectId}:${state.credentialId}`} creator={state.creator} busy={state.busy} onSubmit={state.queue} /> : state.credentialId && !state.error ? <Loader2 className="h-4 w-4 animate-spin" /> : <p className="text-xs text-muted-foreground">Connect and explicitly authorize video.publish to load the current creator posting options.</p>}
    </div>}
  </section>;
}