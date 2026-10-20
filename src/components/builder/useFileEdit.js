import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// PA-9: one file's draft, saved through the existing journalled projectEdit commit path with
// stale-version protection (expected_version → VERSION_CONFLICT).
export default function useFileEdit({ projectId, file, version, onSaved }) {
  const [draft, setDraft] = useState(file?.content || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setDraft(file?.content || ""); setError(null); }, [file?.path, file?.content]);

  const dirty = !!file && draft !== (file.content || "");
  const discard = () => { setDraft(file?.content || ""); setError(null); };
  const save = async () => {
    setSaving(true); setError(null);
    const res = await base44.functions.invoke("projectEdit", {
      action: "commit", project_id: projectId, expected_version: version ?? 0,
      edits: [{ path: file.path, content: draft }], message: `Edited ${file.path}`,
    }).then((r) => ({ data: r.data })).catch((e) => ({ error: e?.response?.data || { error: e.message } }));
    setSaving(false);
    if (res.error) {
      const d = res.error;
      const extra = d.code === "VERSION_CONFLICT" ? " Reload the project and reapply your change." : "";
      setError({ message: (d.error || "Save failed") + extra, details: d.details?.errors || [] });
      return;
    }
    await onSaved?.();
  };
  return { draft, setDraft, dirty, saving, error, save, discard };
}