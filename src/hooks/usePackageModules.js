import { useEffect, useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";

// B5: browser modules for the project's lockfile-pinned packages, from the same server path the
// deployment uses. Refetches only when the lockfile changes; projects without packages skip it.
export default function usePackageModules(projectId, files) {
  const lock = useMemo(() => (files || []).find((f) => f.path === "package.lock.json")?.content || "", [files]);
  const hasPackages = useMemo(() => {
    try { return (JSON.parse(lock || "{}").packages || []).length > 0; } catch { return false; }
  }, [lock]);
  const [state, setState] = useState({ key: null, packages: null, error: null });

  useEffect(() => {
    if (!projectId || !hasPackages) return;
    let alive = true;
    base44.functions.invoke("dependencies", { action: "packageModules", project_id: projectId })
      .then((r) => alive && setState({ key: lock, packages: r.data?.package_modules || null, error: null }))
      .catch((e) => alive && setState({ key: lock, packages: null, error: e.response?.data?.error || e.message }));
    return () => { alive = false; };
  }, [projectId, hasPackages, lock]);

  if (!hasPackages) return { loading: false, packages: null, error: null };
  const ready = state.key === lock;
  return { loading: !ready, packages: ready ? state.packages : null, error: ready ? state.error : null };
}