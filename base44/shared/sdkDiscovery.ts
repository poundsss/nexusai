// Agent + connector DISCOVERY for a deployed application (the sdk.agents / sdk.connectors surface).
//
// This is a read-only projection of the immutable artifact — it owns no engine:
//   agents ..... shared/agentResource.ts declarations, already validated at build time
//   connectors . shared/connectorResource.ts declarations, validated by the integration normalizer
//   execution .. NOT here. An agent runs through the existing run pipeline (authorized builder
//                surface), and a connector is callable ONLY from the existing backend-function
//                runtime, where credentials are resolved server-side.
//
// What the app is allowed to learn is deliberately narrow: names, descriptions, granted tool names,
// declared skills and connector operations. An agent's instructions and every credential reference
// stay server-side, because a browser must never read either.
import { anyEntityRls } from "./rls.ts";

export const AGENT_OPS = ["list", "describe"];
export const CONNECTOR_OPS = ["list", "describe"];

const discoveryError = (code, message, status = 400, details = {}) =>
  Object.assign(new Error(String(message)), { name: "DiscoveryError", code, status, details });

/** Same "this app has users" rule the data and realtime paths use — no second notion of identity. */
const identityRequired = (project, entities) => !!project.rls_enabled || anyEntityRls(entities || []);

/** The app-safe projection of one declared agent. Instructions are deliberately absent. */
const agentView = (a) => ({
  name: a.name,
  description: a.description || "",
  tools: Array.isArray(a.tools) ? [...a.tools] : [],
  skills: Array.isArray(a.skills) ? [...a.skills] : [],
  ...(a.max_steps ? { max_steps: a.max_steps } : {}),
});

/** The app-safe projection of one declared connector. The auth block is deliberately absent. */
const connectorView = (c) => ({
  name: c.name,
  description: c.description || "",
  operations: (c.operations || []).map((o) => ({ name: o.name, method: o.method })),
});

export async function handleAgentsRuntime(_svc, { project, payload, user = null, op, args = {} } = {}) {
  const operation = String(op || "");
  if (!AGENT_OPS.includes(operation)) {
    throw discoveryError("AGENTS_BAD_OPERATION", `Unsupported agents operation '${operation}' (${AGENT_OPS.join(", ")})`, 400);
  }
  const agents = payload?.agents || [];
  if (operation === "list") return { count: agents.length, agents: agents.map(agentView) };

  if (identityRequired(project, payload?.entities) && !user) throw discoveryError("AGENT_AUTH_REQUIRED", "Sign in required", 401);
  const name = String(args.name || "");
  const agent = agents.find((a) => a.name === name);
  if (!agent) throw discoveryError("AGENT_NOT_FOUND", `Agent "${name}" is not part of this deployment`, 404, { agent: name });
  return agentView(agent);
}

export async function handleConnectorsRuntime(_svc, { project, payload, user = null, op, args = {} } = {}) {
  const operation = String(op || "");
  if (!CONNECTOR_OPS.includes(operation)) {
    throw discoveryError("CONNECTORS_BAD_OPERATION", `Unsupported connectors operation '${operation}' (${CONNECTOR_OPS.join(", ")})`, 400);
  }
  const connectors = payload?.connectors || [];
  if (operation === "list") return { count: connectors.length, connectors: connectors.map(connectorView) };

  if (identityRequired(project, payload?.entities) && !user) throw discoveryError("CONNECTOR_AUTH_REQUIRED", "Sign in required", 401);
  const name = String(args.name || "");
  const connector = connectors.find((c) => c.name === name);
  if (!connector) throw discoveryError("CONNECTOR_NOT_FOUND", `Connector "${name}" is not part of this deployment`, 404, { connector: name });
  return connectorView(connector);
}