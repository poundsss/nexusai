import React, { useState } from "react";
import { Loader2, Mail } from "lucide-react";
import EmailDomainRow from "@/components/builder/EmailDomainRow";
import EmailDomainForm from "@/components/builder/EmailDomainForm";
import useEmailDomain from "@/hooks/useEmailDomain";

// Email Domain section on the Builder domain surface. Mirrors the DomainsPane pattern and
// rides ONLY the certified emailDomain endpoint — no direct Base44 API calls from here. The
// surface is bound to this project's certified project → BASE44_APP_ID backend mapping;
// multi-project semantics are unchanged and out of scope.
export default function EmailDomainPane({ projectId }) {
  const ed = useEmailDomain(projectId);
  const [connecting, setConnecting] = useState(false);
  const [actionError, setActionError] = useState(null);

  if (!projectId) return null;

  const run = async (fn) => {
    setActionError(null);
    try { await fn(); } catch (e) { setActionError(String(e?.message || e)); }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <Mail className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-medium text-muted-foreground">Email domain</h3>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Send app email from your connected domain. Only an <span className="font-mono">active</span> domain sends mail — until then the default address is used.
      </p>

      {connecting ? (
        <EmailDomainForm
          working={ed.working}
          submitLabel="Connect domain"
          onSubmit={async (d, name, p) => { await ed.connect(d, name, p); setConnecting(false); }}
          onCancel={() => setConnecting(false)}
        />
      ) : (
        <button onClick={() => setConnecting(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          Use your custom domain
        </button>
      )}

      {ed.error && <p className="mt-2 text-[11px] text-destructive">{ed.error}</p>}
      {actionError && <p className="mt-2 text-[11px] text-destructive">{actionError}</p>}

      <div className="mt-2 space-y-2">
        {ed.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />}
        {!ed.loading && !ed.domains.length && !ed.error && <p className="text-[12px] text-muted-foreground/60">No email domain configured yet.</p>}
        {ed.domains.map((d) => (
          <EmailDomainRow key={d.email_domain_id || d.domain} domain={d} working={ed.working} onRecheck={ed.recheck} onReplace={ed.replace} onDisable={ed.disable} />
        ))}
      </div>
    </div>
  );
}