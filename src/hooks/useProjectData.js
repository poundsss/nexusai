import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { resolveFileRecords, resolveVersionRecords } from "@/lib/fileContent";

// Loads everything the builder needs for one project; `reload` refreshes after AI runs.
export function useProjectData(projectId) {
  const [data, setData] = useState({ project: null, files: [], entities: [], versions: [], runs: [], builds: [], conversation: null, messages: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const [{ data: { project, files: fileRows } }, entityPage, versionPage, runPage, buildPage, conversationPage] = await Promise.all([
        base44.functions.invoke("builderProjectRead", { project_id: projectId }),
        base44.entities.AppEntity.filter({ project_id: projectId }, { sort: "name", limit: 200 }),
        base44.entities.ProjectVersion.filter({ project_id: projectId }, { sort: "-number", limit: 100 }),
        base44.entities.AIRun.filter({ project_id: projectId }, { sort: "-created_date", limit: 50 }),
        base44.entities.Build.filter({ project_id: projectId }, { sort: "-created_date", limit: 20 }),
        base44.entities.Conversation.filter({ project_id: projectId }, { sort: "-created_date", limit: 1 }),
      ]);
      // Oversized file content / snapshots are stored out-of-band; resolve before use.
      const [files, versions] = await Promise.all([
        resolveFileRecords(fileRows || []),
        resolveVersionRecords(versionPage.items || []),
      ]);
      const conversation = (conversationPage.items || [])[0] || null;
      const messages = conversation
        ? (await base44.entities.Message.filter({ conversation_id: conversation.id }, { sort: "created_date", limit: 200 })).items || []
        : [];
      setData({ project, files, entities: entityPage.items || [], versions, runs: runPage.items || [], builds: buildPage.items || [], conversation, messages });
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  return { ...data, loading, error, reload, setData };
}