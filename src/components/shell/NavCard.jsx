import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

// Neutral navigation tile used by the Enterprise and Compliance overviews so
// those areas read as part of the same product rather than separate admin tools.
export default function NavCard({ icon: Icon, title, to, status, children }) {
  return (
    <Link to={to} className="group rounded-lg border border-border bg-background p-4 hover:border-foreground/25 transition-colors block">
      <div className="flex items-center gap-2">
        <span className="h-7 w-7 rounded-md bg-muted text-foreground grid place-items-center shrink-0"><Icon className="h-3.5 w-3.5" /></span>
        <span className="font-semibold text-[13px] truncate">{title}</span>
        {status}
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40 ml-auto shrink-0 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
      </div>
      {children && <div className="mt-2.5 text-[12px] text-muted-foreground">{children}</div>}
    </Link>
  );
}