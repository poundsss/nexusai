// Real ES module sources for the curated catalog (packageRegistry.ts holds the metadata only).
//
// Each package has ONE implementation; a version's module exports exactly the names its catalog
// entry lists, so a curated version can never expose more than the lockfile recorded. Sources are
// plain ESM text, normalized and digested by packageModules.ts like any registry module.
import { packageVersion } from "./packageRegistry.ts";

const IMPL = {
  "@nexus/decimal": {
    imports: "",
    body: `const SCALE = 1e8;
const fix = (n) => Math.round(Number(n) * SCALE) / SCALE;
function add(a, b) { return fix(fix(a) + fix(b)); }
function subtract(a, b) { return fix(fix(a) - fix(b)); }
function multiply(a, b) { return fix(Number(a) * Number(b)); }
function divide(a, b) { if (Number(b) === 0) throw new Error("Division by zero"); return fix(Number(a) / Number(b)); }
function round(a, places = 2) { const f = Math.pow(10, places); return Math.round(Number(a) * f) / f; }`,
  },
  "@nexus/currency": {
    imports: `import { multiply } from "@nexus/decimal";`,
    body: `function formatMoney(amount, currency = "USD") {
  const cents = Math.round(multiply(amount, 100));
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  return sign + whole + "." + String(abs % 100).padStart(2, "0") + " " + currency;
}
function parseMoney(text) { const n = Number(String(text).replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : null; }`,
  },
  "@nexus/strict-decimal": {
    imports: `import { add } from "@nexus/decimal";`,
    body: `function strictAdd(a, b) { if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) throw new Error("strictAdd requires finite numbers"); return add(a, b); }`,
  },
  "@nexus/date-format": {
    imports: "",
    body: `const pad = (n) => String(n).padStart(2, "0");
function formatDate(d) { const x = new Date(d); return x.getUTCFullYear() + "-" + pad(x.getUTCMonth() + 1) + "-" + pad(x.getUTCDate()); }
function parseDate(s) { const x = new Date(String(s) + "T00:00:00Z"); return Number.isNaN(x.getTime()) ? null : x; }
function formatRelative(d, now = Date.now()) { const days = Math.round((new Date(d).getTime() - now) / 86400000); return days === 0 ? "today" : days > 0 ? "in " + days + " day(s)" : -days + " day(s) ago"; }
function formatRange(a, b) { return formatDate(a) + " – " + formatDate(b); }`,
  },
  "@nexus/markdown": {
    imports: "",
    body: `const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function renderInline(s) { return esc(s).replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>").replace(/\\*(.+?)\\*/g, "<em>$1</em>"); }
function renderMarkdown(src) { return String(src).split(/\\n{2,}/).map((b) => b.startsWith("# ") ? "<h1>" + renderInline(b.slice(2)) + "</h1>" : "<p>" + renderInline(b) + "</p>").join(""); }`,
  },
  "@nexus/slugify": {
    imports: "",
    body: `function slugify(s) { return String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }`,
  },
  "@nexus/charts": {
    imports: "",
    body: `const bars = (values) => values.map((v, i) => ({ x: i, y: Number(v) || 0 }));
function LineChart(values) { return { type: "line", points: bars(values || []) }; }
function BarChart(values) { return { type: "bar", points: bars(values || []) }; }`,
  },
  "@nexus/legacy-runtime": {
    imports: "",
    body: `function legacyHelper() { return "legacy"; }`,
  },
};

/** The ESM source of one curated package version, or null when none exists. */
export function curatedModuleSource(name, version) {
  const meta = packageVersion(name, version);
  const impl = IMPL[name];
  if (!meta || !impl) return null;
  const exports = (meta.exports || []).join(", ");
  return `${impl.imports ? impl.imports + "\n" : ""}${impl.body}\nexport { ${exports} };\n`;
}