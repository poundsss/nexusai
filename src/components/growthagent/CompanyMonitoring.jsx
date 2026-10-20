import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export default function CompanyMonitoring({ data, busy, act }) {
  const [label, setLabel] = useState("");
  const [phrases, setPhrases] = useState("");
  return <section className="space-y-4">
    <h2 className="font-heading text-lg">Your Company</h2>
    <p className="text-sm text-muted-foreground">{data.coverage}</p>
    {!data.provider_configured && <p className="text-sm text-destructive">{data.code}: configure the existing Tavily search provider before monitoring.</p>}
    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); act("company_configure", { label: label || data.company_name, terms: phrases ? phrases.split(",").map((s) => s.trim()).filter(Boolean) : [label || data.company_name] }); }}>
      <Input className="flex-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={data.company_name || "Company name"} maxLength={120} aria-label="Company name" />
      <Input className="flex-1" value={phrases} onChange={(e) => setPhrases(e.target.value)} placeholder="Search phrases, comma-separated" aria-label="Search phrases" />
      <Button disabled={busy}>Save monitoring term</Button>
    </form>
    {data.terms?.map((t) => <div key={t.id} className="flex items-center gap-3 rounded border border-border p-3"><div className="flex-1"><p>{t.label}</p><p className="text-sm text-muted-foreground">{t.terms.join(", ")} · {t.status}</p></div><Button variant="outline" disabled={busy} onClick={() => act("company_remove", { term_id: t.id })}>Remove</Button></div>)}
    {!!data.terms?.length && <div className="flex gap-2"><Button disabled={busy || !data.provider_configured} onClick={() => act("company_run")}>Monitor now</Button><Button variant="outline" disabled={busy || !data.provider_configured} onClick={() => act("company_schedule")}>Enable recurring monitoring</Button></div>}
    {!data.observations?.length && <p className="text-sm text-muted-foreground">No stored public mentions yet.</p>}
    {data.observations?.map((o) => <article key={o.id} className="rounded border border-border p-3"><a className="font-medium underline" href={/^https?:\/\//.test(o.url) ? o.url : undefined} target="_blank" rel="noreferrer">{o.title || o.url}</a><p className="mt-1 text-sm">{o.snippet}</p><p className="text-xs text-muted-foreground">{o.source} · {o.observed_at}</p></article>)}
    {data.has_more && <Button variant="outline" disabled={busy} onClick={() => act("company_get", { cursor: data.next_cursor }, true)}>Load more mentions</Button>}
  </section>;
}