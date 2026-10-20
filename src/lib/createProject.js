import { base44 } from "@/api/base44Client";

// Shared project bootstrap used by Home and Projects. The records themselves (Project, scaffold
// files, version 1 and the audit entry) are created SERVER-SIDE: the server derives the acting
// user from the session and authorizes the workspace by membership, so the browser only asks.
// Returns the created project, exactly as before.
export async function createProjectWithScaffold({ workspace, name, description }) {
  const res = await base44.functions.invoke("createProject", {
    workspace_id: workspace.id,
    name,
    description,
  });
  const data = res.data || {};
  if (!data.project) throw new Error(data.error || "Could not create the project");
  return data.project;
}

// A short, human project name derived from the first words of a description.
export function nameFromDescription(description) {
  const words = description.trim().replace(/^(a|an|the)\s+/i, "").split(/\s+/).slice(0, 4).join(" ");
  const name = words.replace(/[^\w\s-]/g, "").trim();
  return (name.charAt(0).toUpperCase() + name.slice(1)) || "New app";
}