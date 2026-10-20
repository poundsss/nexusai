import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

// Backup & Restore rides the certified dataVersions control plane: the frontend only names a
// documented action and passes its fields. Checkpoints, restore progress and undo state are
// displayed exactly as the surface returns them — never inferred.
export default function useDataHistory(projectId, entityName) {
  const [info, setInfo] = useState(null);
  const [checkpoints, setCheckpoints] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [batch, setBatch] = useState(null); // the launched/last restore's status
  const pollRef = useRef(null);

  const call = useCallback(async (payload) => {
    const res = await base44.functions.invoke("dataVersions", { project_id: projectId, ...payload });
    return res.data;
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId || !entityName) return;
    setLoading(true);
    try {
      const [i, list] = await Promise.all([
        call({ action: "info" }),
        call({ action: "list", entity_names: [entityName], limit: 20 }),
      ]);
      setInfo(i);
      setCheckpoints(list.items || []);
      setNextCursor(list.next_cursor || null);
      setError(null);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [projectId, entityName, call]);

  useEffect(() => {
    load();
    return () => { if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; } };
  }, [load]);

  const pollStatus = useCallback(async (batchId) => {
    try {
      const status = await call({ action: "status", batch_id: batchId });
      setBatch(status);
      const ops = status.operations || [];
      const done = ops.length > 0 && ops.every((o) => ["succeeded", "failed"].includes(o.status));
      if (!done) pollRef.current = setTimeout(() => pollStatus(batchId), 1500);
      else load();
    } catch { /* keep the last known state; the next poll retries */ }
  }, [call, load]);

  const restore = useCallback(async (checkpointId) => {
    setWorking(true);
    setError(null);
    try {
      const res = await call({ action: "restore", checkpoint_id: checkpointId, entity_names: [entityName] });
      setBatch({ batch_id: res.batch_id, operations: [], restore_to: null, undo_checkpoint_id: null });
      pollStatus(res.batch_id);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setWorking(false);
    }
  }, [call, entityName, pollStatus]);

  const undo = useCallback(async () => {
    if (!batch?.batch_id) return;
    setWorking(true);
    setError(null);
    try {
      const res = await call({ action: "undo", batch_id: batch.batch_id });
      if (res.batch_id) {
        setBatch({ batch_id: res.batch_id, operations: [], restore_to: null, undo_checkpoint_id: null });
        pollStatus(res.batch_id);
      } else {
        setError(`Restore skipped: ${res.skipped_entities.join(", ")}`);
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setWorking(false);
    }
  }, [batch, call, pollStatus]);

  const download = useCallback(async (checkpoint) => {
    setWorking(true);
    setError(null);
    try {
      const data = await call({ action: "download", entity_name: entityName, checkpoint_id: checkpoint.checkpoint_id });
      const esc = (v) => JSON.stringify(v ?? "");
      const csv = [data.fields.join(","), ...(data.records || []).map((r) => data.fields.map((f) => esc(r[f])).join(","))].join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${entityName}_${checkpoint.data_as_of.slice(0, 19).replace(/[:T]/g, "-")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setWorking(false);
    }
  }, [call, entityName]);

  const more = useCallback(async () => {
    if (!nextCursor) return;
    try {
      const list = await call({ action: "list", entity_names: [entityName], limit: 20, cursor: nextCursor });
      setCheckpoints((c) => [...c, ...(list.items || [])]);
      setNextCursor(list.next_cursor || null);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [call, entityName, nextCursor]);

  return { info, checkpoints, nextCursor, loading, working, error, batch, restore, undo, download, more, reload: load };
}