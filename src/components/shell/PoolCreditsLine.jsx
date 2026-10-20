import React from "react";
import { Link } from "react-router-dom";
import { useShellData } from "@/hooks/useShellData";
import { fmtCredits } from "@/lib/planCredits";

// Per-pool balance line: Message and Integration shown separately (current / included), never summed.
export default function PoolCreditsLine() {
  const { credits } = useShellData();
  const pool = (label, p) => (
    <span>
      {label} credits:{" "}
      <span className="font-mono tabular-nums text-foreground">{fmtCredits(p.available)}</span>
      {" / "}
      <span className="font-mono tabular-nums">{fmtCredits(p.included)}</span>
    </span>
  );
  return (
    <div className="mt-8 flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
      {pool("Message", credits.message)}
      {pool("Integration", credits.integration)}
      <Link to="/billing" className="underline underline-offset-2 hover:text-foreground transition-colors">Manage</Link>
    </div>
  );
}