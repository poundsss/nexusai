import React from "react";

// Compact read-only listing. Columns are [header, render] pairs; nothing here mutates.
export default function AdminTable({ title, subtitle, columns, rows, empty = "Nothing to show." }) {
  return (
    <section className="border border-border rounded-lg overflow-hidden">
      <header className="flex items-baseline gap-2 px-3 py-2 border-b border-border bg-muted/40">
        <h2 className="text-[12.5px] font-semibold">{title}</h2>
        {subtitle && <span className="text-[11px] text-muted-foreground truncate">{subtitle}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-[11.5px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                {columns.map(([h]) => <th key={h} className="font-medium px-3 py-1.5 whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id || i} className="border-t border-border/70 hover:bg-muted/40">
                  {columns.map(([h, render]) => (
                    <td key={h} className="px-3 py-1.5 align-top max-w-[280px] truncate">{render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}