import React from "react";

// Shared dense table used by usage, billing and audit surfaces so every
// tabular surface in the product reads identically.
// columns: [{ key, label, align, mono, render }]
export default function DataList({ columns, rows, empty }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-border px-4 py-10 text-center text-[12.5px] text-muted-foreground">
        {empty || "Nothing here yet."}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground ${c.align === "right" ? "text-right" : ""}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || i} className="border-b border-border/60 last:border-0 hover:bg-muted/40 transition-colors">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-4 py-2.5 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.mono ? "font-mono text-[11.5px]" : ""}`}
                >
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}