// Regression test for the Expense Tracker "Recent expenses stuck on Loading" bug.
//
// ROOT CAUSE: ExpenseList.js called `currencyFormatter(expense.amount)` where
// `currencyFormatter` is an `Intl.NumberFormat` instance (created with `new Intl.NumberFormat(...)`).
// An Intl.NumberFormat is an object, not a function — calling it throws
// `TypeError: currencyFormatter is not a function` during render. The throw happens
// AFTER the total/count DOM nodes are applied but BEFORE the list renders, so the
// list stays stuck on "Loading expenses…" while the summary cards update.
//
// This test verifies:
// 1. The fixed ExpenseList source uses `.format()` (the correct API).
// 2. The old broken pattern `currencyFormatter(` (bare call) is gone.
// 3. A create → list round-trip through the data layer returns the saved record.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { builderProjectRead } from "../../shared/builderProjectRead.ts";

export const config = { method: "POST" };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const results = [];
  const check = (name, ok, detail) =>
    results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });

  const pid = "6aa6d601dcbcb19739680f37";

  // --- Source-level regression check -----------------------------------------

  const user = await base44.auth.me();
  const files = (await builderProjectRead(base44, user, pid, "src/components/ExpenseList.js")).files
    .filter((f) => f.path === "src/components/ExpenseList.js");
  const src = files[0]?.content || "";

  const hasFormatCall = /\.format\s*\(/.test(src);
  const hasBareCall = /currencyFormatter\(/.test(src) && !/currencyFormatter\.format\(/.test(src);

  check(
    "ExpenseList uses currencyFormatter.format()",
    hasFormatCall,
    hasFormatCall ? "found .format() call" : "no .format() call found"
  );

  check(
    "ExpenseList does not call currencyFormatter as a bare function",
    !hasBareCall,
    hasBareCall ? "regressed: bare currencyFormatter() call present" : "clean"
  );

  // --- Intl.NumberFormat API contract ---------------------------------------
  // Prove the bug reproduces with the old pattern and is fixed with the new one.

  let formatOk = false;
  let formatError = "";
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
    const formatted = fmt.format(25);
    formatOk = typeof formatted === "string" && formatted.includes("25");
  } catch (e) {
    formatError = e.message;
  }
  check(
    "Intl.NumberFormat.format() produces a currency string",
    formatOk,
    formatOk ? "format(25) succeeded" : "failed: " + formatError
  );

  let bareCallThrows = false;
  let bareCallError = "";
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
    fmt(25); // intentionally wrong — must throw
  } catch (e) {
    bareCallThrows = true;
    bareCallError = e.message;
  }
  check(
    "Calling an Intl.NumberFormat instance as a function throws",
    bareCallThrows,
    bareCallThrows ? "threw as expected" : "did NOT throw — bug would not reproduce"
  );

  // --- CRUD round-trip through the data layer --------------------------------
  // The bug masked itself as a "loading" issue; confirm the underlying create → list
  // path actually works so a future regression in the data layer is caught too.

  let crudOk = false;
  let crudError = "";
  let createdId = null;
  try {
    const created = await base44.entities.AppRecord.create({
      project_id: pid,
      entity_name: "Expense",
      data: {
        amount: 25,
        category: "test-regression",
        description: "regression test expense",
        date: new Date().toISOString().slice(0, 10),
      },
    });
    createdId = created.id;

    const rows = await base44.entities.AppRecord.filter(
      { project_id: pid, entity_name: "Expense" },
      "-created_date",
      1000
    );
    const found = rows
      .map((r) => ({ id: r.id, ...(r.data || {}) }))
      .find((r) => r.id === createdId);
    crudOk = !!found && found.amount === 25;
  } catch (e) {
    crudError = e.message;
  } finally {
    if (createdId) {
      try { await base44.entities.AppRecord.delete(createdId); } catch { /* cleanup best-effort */ }
    }
  }
  check(
    "Expense create → list round-trip returns the saved record",
    crudOk,
    crudOk ? "round-trip succeeded" : "failed: " + crudError
  );

  const failed = results.filter((r) => !r.ok);
  return Response.json({
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed,
    results,
  });
}