import React, { useState } from "react";

// The connect/replace form: connected domain + sender name + address prefix. The prefix is
// combined into from_email = prefix@domain at submit time (no CNAME or status is invented
// here — everything beyond the form is the certified endpoint's own verdict).
export default function EmailDomainForm({ initial, working, submitLabel, onSubmit, onCancel }) {
  const [domain, setDomain] = useState(initial?.domain || "");
  const [senderName, setSenderName] = useState(initial?.sender_name || "");
  const [prefix, setPrefix] = useState(initial?.prefix || "");
  const [formError, setFormError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const d = domain.trim().toLowerCase();
    const name = senderName.trim();
    const p = prefix.trim();
    if (!d || !name || !p) { setFormError("Domain, sender name and address prefix are required."); return; }
    if (p.includes("@")) { setFormError("Address prefix is the part before @ — e.g. support."); return; }
    setFormError(null);
    try { await onSubmit(d, name, p); } catch (err) { setFormError(String(err?.message || err)); }
  };

  const input = "min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
      <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="your-domain.com" className={input} />
      <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Sender name" className="w-44 rounded-md border border-input bg-background px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring" />
      <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Address prefix (support)" className="w-52 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-ring" />
      <button type="submit" disabled={working} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
        {submitLabel}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel} disabled={working} className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
          Cancel
        </button>
      )}
      {prefix && domain.trim() && <span className="text-[11px] text-muted-foreground">from: <span className="font-mono">{prefix.trim()}@{domain.trim().toLowerCase()}</span></span>}
      {formError && <p className="w-full text-[11px] text-destructive">{formError}</p>}
    </form>
  );
}