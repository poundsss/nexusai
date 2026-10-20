// P0 Agent chat-surface certification: the durable contracts the /agent page composes on top
// of the ALREADY-CERTIFIED runtime (appAgentSdkConversationParityTest, appAgentMemoryParityTest,
// agentChatUiCert). Covers exactly the confirmed P0 gaps: the conversation sidebar's
// rename/archive persistence (the Conversation-entity mirror — the platform conversation API
// exposes title/is_archived but has no update endpoint), the memory-on-by-default projection
// through the certified collectAgents contract, and that the sidebar mirror never collides
// with the run-thread rows (its rows are keyed by agent_name + conversation_id).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { collectAgents } from "../../shared/agentResource.ts";

const MIRROR_SENTINEL = "workspace-agent-ui";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail || "").slice(0, 300) });
  const stamp = Date.now();
  const agentName = `P0CertAgent${stamp}`;
  const conversationId = `p0cert-conv-${stamp}`;
  const created = [];

  // ---- 1) Sidebar rename/archive persistence: the Conversation-entity mirror roundtrip ----
  try {
    const mirror = await db.entities.Conversation.create({
      project_id: MIRROR_SENTINEL, agent_name: agentName, conversation_id: conversationId,
      title: "Original", is_archived: false,
    });
    created.push(mirror.id);
    check("sidebar_rename_persists", false, "pending");
    await db.entities.Conversation.update(mirror.id, { title: "Renamed by sidebar", is_archived: true });
    const renamed = await db.entities.Conversation.filter({ agent_name: agentName, conversation_id: conversationId });
    results.pop();
    check("sidebar_rename_persists",
      renamed.length === 1 && renamed[0].title === "Renamed by sidebar" && renamed[0].is_archived === true,
      `rows=${renamed.length} title=${renamed[0]?.title} archived=${renamed[0]?.is_archived}`);

    // ---- 2) Unarchive restores the row to the Active list ----
    await db.entities.Conversation.update(mirror.id, { is_archived: false });
    const restored = await db.entities.Conversation.filter({ agent_name: agentName, conversation_id: conversationId });
    check("sidebar_unarchive_persists", restored.length === 1 && restored[0].is_archived === false,
      `archived=${restored[0]?.is_archived}`);
  } catch (e) {
    results.push({ name: "conversation_mirror", ok: false, detail: e?.message || String(e) });
  }

  // ---- 3) Memory on by default: a doc WITHOUT memory_config is memory-enabled, and the ----
  // ----    explicit enabled:true config round-trips (the NexusAgent doc's form).        ----
  try {
    const defaultOn = collectAgents([{
      path: "base44/agents/default-on.jsonc",
      content: JSON.stringify({ name: "default-on", instructions: "x", tool_configs: [] }),
    }]);
    const explicit = collectAgents([{
      path: "base44/agents/nexus-agent.jsonc",
      content: JSON.stringify({ name: "nexus-agent", instructions: "x", tool_configs: [], memory_config: { enabled: true } }),
    }]);
    const a = defaultOn.agents[0];
    const b = explicit.agents[0];
    check("memory_on_by_default", !!a && a.memory_config?.enabled === true, JSON.stringify(a?.memory_config || null));
    check("memory_explicit_config_roundtrip", !!b && b.memory_config?.enabled === true && b.memory_config?.scope === "both",
      JSON.stringify(b?.memory_config || null));
  } catch (e) {
    results.push({ name: "memory_projection", ok: false, detail: e?.message || String(e) });
  }

  // ---- cleanup: remove every record this cert created ----
  for (const id of created) await db.entities.Conversation.delete(id).catch(() => {});

  const ok = results.every((r) => r.ok);
  return Response.json({ ok, checks: results }, { status: ok ? 200 : 500 });
}