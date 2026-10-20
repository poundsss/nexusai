import React from "react";
import { CheckCircle2, AlertCircle, MinusCircle } from "lucide-react";

const ICON = {
  ok: <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />,
  warn: <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />,
  off: <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
};

export default function ReadinessItem({ tone, label, detail }) {
  return (
    <li className="flex items-start gap-2 py-1">
      {ICON[tone]}
      <div className="min-w-0">
        <p className="text-[12px] text-foreground">{label}</p>
        {detail && <p className="text-[11px] text-muted-foreground">{detail}</p>}
      </div>
    </li>
  );
}