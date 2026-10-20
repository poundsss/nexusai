import React, { useState } from "react";
import { X, ChevronLeft } from "lucide-react";
import { formatAnswers } from "@/lib/growQuestions";

// Agent-requested questions, one at a time, in place of the Grow composer.
export default function GrowQuestionnaire({ questions, disabled, onSubmit, onDismiss }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [typed, setTyped] = useState({});
  const q = questions[step];
  const last = step === questions.length - 1;
  const picked = answers[q.id] || [];
  const toggle = (o) => setAnswers((a) => ({ ...a, [q.id]: q.type === "multi" ? (picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o]) : (picked[0] === o ? [] : [o]) }));
  const valueOf = (x) => [...(answers[x.id] || []), (typed[x.id] || "").trim()].filter(Boolean);
  const finish = (skipCurrent) => {
    const out = {};
    questions.forEach((x) => { out[x.id] = skipCurrent && x.id === q.id ? [] : valueOf(x); });
    onSubmit(formatAnswers(questions, out));
  };
  const next = (skip) => {
    if (last) return finish(skip);
    if (skip) { setAnswers((a) => ({ ...a, [q.id]: [] })); setTyped((t) => ({ ...t, [q.id]: "" })); }
    setStep(step + 1);
  };
  const hasValue = valueOf(q).length > 0;

  return (
    <div className="flex max-h-[60vh] flex-col rounded-[inherit] px-5 pt-3 pb-2.5">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 break-words text-[13px] font-medium leading-snug">{q.label}</p>
        {questions.length > 1 && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{step + 1}/{questions.length}</span>}
        <button type="button" onClick={onDismiss} aria-label="Close questions" className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><X className="h-3 w-3" /></button>
      </div>
      <div className="min-h-0 overflow-y-auto scrollbar-thin">
        {q.options.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {q.options.map((o) => (
              <button key={o} type="button" onClick={() => toggle(o)} className={`rounded-full border px-2.5 py-0.5 text-[11.5px] leading-5 transition-colors ${picked.includes(o) ? "border-foreground bg-foreground text-background" : "border-border bg-muted/40 text-foreground/80 hover:border-foreground/30 hover:text-foreground"}`}>{o}</button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 flex shrink-0 items-center gap-2 border-t border-border/60 pt-2">
        {questions.length > 1 && (
          <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)} aria-label="Previous question" className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <input
          value={typed[q.id] || ""}
          onChange={(e) => setTyped((t) => ({ ...t, [q.id]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter" && hasValue && !disabled) next(false); }}
          placeholder="Or type your own answer…"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/60"
        />
        <button type="button" disabled={disabled} onClick={() => next(true)} className="shrink-0 px-1.5 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-40">Skip</button>
        <button type="button" disabled={disabled || !hasValue} onClick={() => next(false)} className="shrink-0 rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground transition-colors disabled:bg-muted disabled:text-muted-foreground">{last ? "Send" : "Next"}</button>
      </div>
    </div>
  );
}