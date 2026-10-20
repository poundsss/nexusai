// Minimal, dependency-free 5-field cron parser + next-fire computation.
//
// Supports: * (any), N (single), N-M (range), N-M/S (stepped range), */S (every S
// from field start), A,B,C (lists of any of the above). Day-of-week 0 and 7 both
// mean Sunday. Standard Vixie rule: when BOTH day-of-month and day-of-week are
// restricted (not a bare *), the command fires when EITHER matches; if one is *,
// only the other constrains the day.
//
// This is intentionally small — it covers the cadences a generated app's scheduled
// function needs. It is NOT a full Quartz parser (no L, W, #, ? or year field).

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 }, // 7 normalized to 0 (Sunday)
];

function parseField(field, def) {
  const out = new Set();
  for (const part of String(field).split(",")) {
    if (part === "") continue;
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      step = parseInt(part.slice(slash + 1), 10);
      range = part.slice(0, slash);
      if (!Number.isFinite(step) || step < 1) throw new Error(`cron: invalid step "${part}"`);
    }
    let lo, hi;
    if (range === "*") { lo = def.min; hi = def.max; }
    else {
      const dash = range.indexOf("-");
      if (dash >= 0) {
        lo = parseInt(range.slice(0, dash), 10);
        hi = parseInt(range.slice(dash + 1), 10);
      } else {
        lo = parseInt(range, 10);
        hi = lo;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`cron: invalid value "${part}" in ${def.name}`);
    if (lo < def.min || hi > def.max || lo > hi) throw new Error(`cron: ${def.name} value out of range: ${part}`);
    for (let v = lo; v <= hi; v += step) {
      if (def.name === "dow" && v === 7) out.add(0);
      else out.add(v);
    }
  }
  if (!out.size) throw new Error(`cron: empty ${def.name} field`);
  return out;
}

export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got ${parts.length}: "${expr}"`);
  const f = {};
  FIELDS.forEach((def, i) => { f[def.name] = parseField(parts[i], def); });
  f.domStar = parts[2] === "*";
  f.dowStar = parts[4] === "*";
  return f;
}

// Next matching time STRICTLY AFTER `after`. Seconds and ms are floored to 0.
//
// Jump-by-field: when a field doesn't match, skip to the start of the next unit that
// could match (month → day → hour → minute) instead of scanning minute-by-minute.
// Worst case is ~366 days + 24 hours + 60 minutes of iterations, not hundreds of
// thousands — so even sparse schedules (e.g. "0 0 1 1 *" from mid-year) resolve fast.
const SEARCH_CAP = 366 * 24 + 1; // generous safety net; the jump algorithm stays far under this

export function nextRun(fields, after) {
  let t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + 60000); // first candidate is the next minute boundary
  for (let i = 0; i < SEARCH_CAP; i++) {
    if (!fields.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue;
    }
    const domMatch = fields.dom.has(t.getDate());
    const dowMatch = fields.dow.has(t.getDay());
    const dayMatch = fields.domStar && fields.dowStar ? true
      : fields.domStar ? dowMatch
      : fields.dowStar ? domMatch
      : domMatch || dowMatch;
    if (!dayMatch) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!fields.hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!fields.minute.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
    return t;
  }
  throw new Error("cron: no matching time within one year — check the expression");
}

// --- time zones (NEXUSAI-DERIVED algorithm; Base44 documents "a time you define in your
// timezone" for scheduled workflows but publishes no offset method) ---------------------------
// Offset (ms to ADD to a UTC instant to read it as the zone's wall clock), derived through
// Intl — DST-correct for any IANA zone. An unknown zone throws (validated at registration).
export function tzOffsetMs(t, tz) {
  if (!tz || tz === "UTC") return 0;
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: String(tz), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(t)) if (type !== "literal") parts[type] = value;
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - t.getTime();
}

// Next cron match STRICTLY AFTER `after`, where the expression is evaluated against the ZONE's
// wall-clock time. The wall-clock candidate is mapped back to the real UTC instant, refined
// over DST edges with a bounded 1-minute walk (≤ 4 hours — DST shifts are ≤ 2), and imaginary
// local times resolve forward.
export function nextRunInZone(fields, after, tz) {
  if (!tz || tz === "UTC") return nextRun(fields, after);
  const wall = new Date(after.getTime() + tzOffsetMs(after, tz));
  const wallNext = nextRun(fields, wall);
  let utc = new Date(wallNext.getTime() - tzOffsetMs(wallNext, tz));
  for (let i = 0; i < 240 && utc.getTime() + tzOffsetMs(utc, tz) !== wallNext.getTime(); i++) {
    utc = new Date(utc.getTime() + 60000);
  }
  if (utc.getTime() <= after.getTime()) utc = new Date(after.getTime() + 60000);
  return utc;
}