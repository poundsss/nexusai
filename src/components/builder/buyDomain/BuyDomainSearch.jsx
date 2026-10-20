import React, { useState } from "react";
import { Loader2, Search } from "lucide-react";

const fmtMoney = (m) => (m ? new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency || "USD" }).format(m.value / 100) : null);

export default function BuyDomainSearch({ searching, working, results, error, onSearch, onSelect }) {
  const [query, setQuery] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="yourname.com"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}Search
        </button>
      </form>

      {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}

      {results && (
        <div className="mt-3 space-y-1.5">
          {results.length === 0 && <p className="text-[12px] text-muted-foreground">No results. Try another name.</p>}
          {results.map((r) => (
            <div key={r.domain} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-[13px]">{r.domain}</p>
                <p className="text-[11px] text-muted-foreground">
                  {r.available === false ? "Taken" : r.renewal_price ? `Renews at ${fmtMoney(r.renewal_price)}/yr` : " "}
                </p>
              </div>
              {r.available && r.price && (
                <button
                  disabled={working}
                  onClick={() => onSelect(r.domain)}
                  className="ml-3 shrink-0 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {fmtMoney(r.price)} — Select
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}