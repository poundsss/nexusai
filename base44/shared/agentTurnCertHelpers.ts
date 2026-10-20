// Shared helpers for the R-3/R-4 agent-turn certifications (scripted model, scratch fixtures).
export const taskCreateStep = (title) => ({ action: "tool", tool: { name: "entity_task_create", input: { data: { title } } } });
export const countTasks = async (db, projectId) => (await db.entities.AppRecord.filter({ project_id: projectId, entity_name: "task" }, "-created_date", 50)).length;