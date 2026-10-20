// Allowlisted toolbar values — a subset of the server's STYLE_GROUPS (server re-validates).
export const STYLE_OPTIONS = [
  { group: "text_color", label: "Text color", values: ["text-foreground", "text-muted-foreground", "text-primary", "text-white", "text-black", "text-slate-700", "text-blue-600", "text-green-600", "text-red-600", "text-amber-600"] },
  { group: "bg_color", label: "Background", values: ["bg-background", "bg-card", "bg-muted", "bg-primary", "bg-secondary", "bg-white", "bg-slate-100", "bg-blue-600", "bg-green-600", "bg-red-600"] },
  { group: "font_size", label: "Font size", values: ["text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-3xl", "text-4xl"] },
  { group: "font_weight", label: "Weight", values: ["font-normal", "font-medium", "font-semibold", "font-bold"] },
  { group: "text_align", label: "Align", values: ["text-left", "text-center", "text-right"] },
  { group: "padding", label: "Padding", values: ["p-0", "p-1", "p-2", "p-3", "p-4", "p-6", "p-8"] },
  { group: "margin", label: "Margin", values: ["m-0", "m-1", "m-2", "m-4", "m-6", "m-8"] },
  { group: "radius", label: "Corners", values: ["rounded-none", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-full"] },
];

export const describeChanges = (changes) => [
  changes.text != null ? `set its text to "${changes.text}"` : null,
  ...Object.entries(changes.classes || {}).map(([g, v]) => `use the Tailwind class ${v} for ${g.replace("_", " ")}`),
].filter(Boolean).join(", ");