// Dry-run evaluation dataset parity (certification only). A stored evaluation is reusable only when its
// fingerprint matches the trajectory's CURRENT state; otherwise the dry run must show the placeholder
// `dryrun_eval_<recomputed fingerprint>` — exactly the record a real cycle would create. Pure: readers
// are injected, so this never writes.
export async function verifyDryEvalItems(items, { expectedCount, expectedKeys, stored, recompute }) {
  const problems = [];
  if (items.length !== expectedCount) problems.push(`count ${items.length} != expected ${expectedCount}`);
  const keys = new Set(items.map((i) => i.item_key));
  for (const k of expectedKeys) if (!keys.has(k)) problems.push(`missing ${k}`);
  for (const k of keys) if (!expectedKeys.includes(k)) problems.push(`unexpected ${k}`);
  for (const i of items) {
    const tid = i.lineage?.trajectory_id;
    if (i.lineage?.evaluation_id !== i.evaluation_id) { problems.push(`${i.item_key}: lineage evaluation_id differs`); continue; }
    const fp = await recompute(tid);
    if (i.evaluation_id === `dryrun_eval_${fp}`) continue;
    const e = await stored(i.evaluation_id);
    if (!e || e.trajectory_id !== tid || e.inputs_hash !== fp) problems.push(`${i.item_key}: ${i.evaluation_id} is neither a matching stored evaluation nor dryrun_eval_${fp}`);
  }
  return { ok: problems.length === 0, problems };
}