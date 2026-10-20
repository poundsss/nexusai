import React from "react";

// Four-pointed star with a small plus at the top-right — the "auto / Nexus" mark.
export function SparklePlus({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M9 3c0 3 3 6 6 6-3 0-6 3-6 6 0-3-3-6-6-6 3 0 6-3 6-6z" />
      <path d="M17.4 4v1.8h1.8v1.4h-1.8v1.8h-1.4V7.2h-1.8V5.8h1.8V4z" />
    </svg>
  );
}

// Google Gemini — the four-pointed concave "sparkle".
export function GeminiMark({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 0c0 6.63 4.37 11 11 11-6.63 0-11 4.37-11 11 0-6.63-4.37-11-11-11C7.63 11 12 6.63 12 0z" />
    </svg>
  );
}

// OpenAI — the six-petal knot.
export function OpenAIMark({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.53-2.908A6.065 6.065 0 0 0 4.99 4.099a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .742 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.531 2.905 5.985 5.985 0 0 0 4.504 2.099 6.051 6.051 0 0 0 5.781-4.207 5.985 5.985 0 0 0 3.997-2.9 6.051 6.051 0 0 0-.742-7.066zm-9.022 12.602a4.475 4.475 0 0 1-2.876-1.04l.143-.08 4.778-2.758a.795.795 0 0 0 .392-.681v-6.737l2.019 1.168a.072.072 0 0 1 .04.056v5.58a4.484 4.484 0 0 1-4.496 4.495zm-9.649-4.128a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.776.776 0 0 0 .78 0l5.843-3.369v2.336a.08.08 0 0 1-.032.07l-4.83 2.786a4.484 4.484 0 0 1-6.151-1.633zM2.336 7.044a4.473 4.473 0 0 1 2.366-1.973V10.5a.764.764 0 0 0 .392.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.07 0l-4.83-2.786a4.484 4.484 0 0 1-1.653-6.131zm16.474 3.852L12.95 7.526l2.019-1.163a.076.076 0 0 1 .07 0l4.83 2.786a4.484 4.484 0 0 1-.676 8.095V11.58a.79.79 0 0 0-.404-.684zm2.01-3.023-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.578 8.176V5.84a.08.08 0 0 1 .032-.07l4.83-2.782a4.484 4.484 0 0 1 6.68 4.694zM8.532 12.68l-2.019-1.164a.08.08 0 0 1-.04-.057V5.988a4.484 4.484 0 0 1 7.357-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.392.681zm1.097-2.365 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5z" />
    </svg>
  );
}

// Claude (Anthropic) — the radiating sunburst.
export function ClaudeMark({ className }) {
  const rays = [
    [15.2, 12, 21, 12], [14.77, 13.6, 19.79, 16.5], [13.6, 14.77, 16.5, 19.79],
    [12, 15.2, 12, 21], [10.4, 14.77, 7.5, 19.79], [9.23, 13.6, 4.21, 16.5],
    [8.8, 12, 3, 12], [9.23, 10.4, 4.21, 7.5], [10.4, 9.23, 7.5, 4.21],
    [12, 8.8, 12, 3], [13.6, 9.23, 16.5, 4.21], [14.77, 10.4, 19.79, 7.5],
  ];
  return (
    <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" className={className} aria-hidden>
      {rays.map((r, i) => (
        <line key={i} x1={r[0]} y1={r[1]} x2={r[2]} y2={r[3]} />
      ))}
    </svg>
  );
}

// Per-provider icon for a model entry — each provider's real brand mark.
export function ModelIcon({ provider, display_name }) {
  const key = `${provider || ""} ${display_name || ""}`.toLowerCase();
  if (key.includes("google") || key.includes("gemini")) {
    return <GeminiMark className="h-4 w-4 text-[#1A73E8]" />;
  }
  if (key.includes("openai") || key.includes("gpt")) {
    return <OpenAIMark className="h-4 w-4 text-foreground" />;
  }
  if (key.includes("anthropic") || key.includes("claude") || key.includes("sonnet") || key.includes("opus") || key.includes("haiku")) {
    return <ClaudeMark className="h-4 w-4 text-[#D97757]" />;
  }
  if (key.includes("base")) {
    return <span className="block h-2.5 w-5 rounded-t-full bg-orange-500" aria-hidden />;
  }
  return <SparklePlus className="h-4 w-4 text-foreground" />;
}