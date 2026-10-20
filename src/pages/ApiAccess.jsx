import React from "react";
import { Code2, Terminal, Copy, KeyRound } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import AccountPage from "@/components/shell/AccountPage";
import PatSection from "@/components/settings/PatSection";
import { toast } from "@/components/ui/use-toast";

// API access surface. The ONLY app-data API credential is a Personal Access Token (PAT) —
// `publicAppDataApi` is a GET-only REST endpoint that authenticates a Bearer PAT. No new auth
// model: this page documents the endpoint + SDK shape and reuses the existing PAT management.
const ORIGIN = typeof window !== "undefined" ? window.location.origin : "https://your-app.base44.app";

const curlExample = `curl -H "Authorization: Bearer <PAT>" \\
  "${ORIGIN}/api/apps/{app_id}/entities/{entity_name}?limit=50"`;

const jsExample = `const res = await fetch(
  "${ORIGIN}/api/apps/{app_id}/entities/{entity_name}",
  { headers: { Authorization: "Bearer <PAT>" } }
);
const rows = await res.json();`;

function Block({ title, code }) {
  const copy = () => { navigator.clipboard?.writeText(code); toast({ title: "Copied" }); };
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">{title}</span>
        <button onClick={copy} className="ml-auto text-muted-foreground hover:text-foreground transition-colors" aria-label="Copy"><Copy className="h-3.5 w-3.5" /></button>
      </div>
      <pre className="overflow-x-auto font-mono text-[11.5px] leading-relaxed text-muted-foreground whitespace-pre">{code}</pre>
    </div>
  );
}

export default function ApiAccess() {
  const { user, workspace, loading } = useWorkspace();
  return (
    <AccountPage loading={loading} title="API access" subtitle="Read your app data over REST with a personal access token.">
      <section className="rounded-lg border border-border p-5">
        <div className="flex items-start gap-3">
          <span className="h-10 w-10 rounded-lg grid place-items-center shrink-0 bg-muted text-muted-foreground"><Code2 className="h-5 w-5" /></span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">Public app data API</h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              <code className="font-mono text-[12px]">GET /api/apps/&#123;app_id&#125;/entities/&#123;entity_name&#125;</code> with an
              <code className="font-mono text-[12px]"> Authorization: Bearer &lt;PAT&gt;</code> header. GET only. Replace
              <code className="font-mono text-[12px]"> app_id</code> with the project id and
              <code className="font-mono text-[12px]"> entity_name</code> with the entity you want to read.
            </p>
            <div className="mt-3 space-y-2">
              <Block title="cURL" code={curlExample} />
              <Block title="JavaScript" code={jsExample} />
            </div>
            <p className="mt-2.5 text-[11.5px] text-muted-foreground/70">
              A PAT scoped to one app can read that app's entities; a full-access PAT can read any app the account may access. Revoked or expired tokens fail closed.
            </p>
          </div>
        </div>
      </section>

      <div className="mt-4 flex items-center gap-2 text-[12px] text-muted-foreground">
        <KeyRound className="h-3.5 w-3.5" />Credentials are personal access tokens — create, list and revoke them below.
      </div>
      <div className="mt-2">
        <PatSection workspace={workspace} user={user} />
      </div>
    </AccountPage>
  );
}