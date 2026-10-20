import React, { useState } from "react";
import Section from "@/components/shell/Section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Bounded export of this application's events.
//
// The export is produced entirely by the EXISTING `export` operator action, which requires
// analytics.export, clamps the range and page size, and re-applies the project's redaction before
// returning a row. The browser only asks for a page and offers the returned payload as a download —
// it never assembles an export from raw events or widens what the server chose to reveal.
export default function AnalyticsExportSection({ query }) {
  const [limit, setLimit] = useState(200);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try {
      const d = await query("export", { limit: Number(limit) || 200, offset: Number(offset) || 0 });
      setResult(d);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Export unavailable");
    } finally { setRunning(false); }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `analytics-${result.project_id}-${result.environment}-${result.offset}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Section title="Export" description="Download a bounded page of events, redacted exactly as the server returns them.">
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Rows</Label>
            <Input className="mt-1 h-8 w-28 text-[12.5px]" type="number" min="1" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>
          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Offset</Label>
            <Input className="mt-1 h-8 w-28 text-[12.5px]" type="number" min="0" value={offset} onChange={(e) => setOffset(e.target.value)} />
          </div>
          <Button size="sm" disabled={running} onClick={run}>{running ? "Preparing…" : "Prepare export"}</Button>
          {result && <Button size="sm" variant="outline" onClick={download}>Download JSON</Button>}
        </div>
        {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        {result && (
          <div className="text-[12.5px] text-muted-foreground space-y-1">
            <p>
              {result.returned.toLocaleString()} rows from {result.environment}, offset {result.offset}
              {result.has_more ? " — more rows remain, raise the offset for the next page." : " — end of this range."}
            </p>
            <p>
              Credential-like properties are {result.redaction?.credential_policy === "redact" ? "redacted" : "refused at ingestion"}
              {(result.redaction?.suppressed_properties || []).length ? `; suppressed keys: ${result.redaction.suppressed_properties.join(", ")}` : ""}.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}