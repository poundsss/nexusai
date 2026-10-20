// Names exported by the generated-app runtime module ('runtime').
// Must stay in sync with src/lib/runtime/runtimeSource.js on the frontend.
export const RUNTIME_EXPORTS = [
  "html", "render", "h",
  "useState", "useEffect", "useMemo", "useRef", "useCallback", "useReducer",
  "db", "auth", "users", "files", "server", "analytics", "navigate", "useRoute", "Link",
  // App User Connectors (P-9.9): connectAppUser / disconnectAppUser / connections.
  "connectors",
  // AppModule parity (SDK 0.8.52): getPublicSettings — the documented "before app boot" surface.
  "app",
  // AppLogsModule parity (SDK 0.8.52): the DOCUMENTED public method logUserInApp(pageName) — one
  // alias over the EXISTING analytics dispatcher (shared/analyticsRuntime.ts op log_user_in_app).
  // The sdk.appLogs alias rides the existing analytics relays in both runtimes. Frontend twin:
  // src/lib/runtime/runtimeSource.js.
  "appLogs",
  // IntegrationsModule parity: Core.* endpoints + custom.call, dispatched server-side onto the
  // EXISTING certified primitives (see shared/appIntegrations.ts).
  "integrations",
  // In-app notification inbox (shared/appNotifications.ts).
  "notifications",
  // Deployed in-app agents (P-9.10B/P-9.10C): createConversation / listConversations /
  // getConversation / addMessage / subscribeToConversation / getTelegramConnectURL /
  // getWhatsAppConnectURL — thin bridges over the existing P-9.4 runtime and the P-9.10A/C
  // channel flows.
  "agents",
  // AgentChat (P-9.12): the compact in-app conversation widget, composed ONLY of the certified
  // agents methods (create/get/subscribe/addMessage). Frontend twin: src/lib/runtime/runtimeSource.js.
  "AgentChat",
  // ActorsModule parity (SDK 0.8.52): the actors adapter over the EXISTING realtime bridge ops
  // (list/connect/disconnect/send/events) + base44.cleanup() (closes live actor connections).
  // Bounded-poll transport — the documented WebSocket is NOT claimed. Frontend twin:
  // src/lib/runtime/runtimeSource.js.
  "actors", "cleanup",
  // The unified developer surface: ONE `sdk` object aliasing the runtime surfaces above, plus the
  // `types` descriptor naming the project's generated declarations. Both are adapters — every call
  // still travels the same existing contract, so the legacy named imports remain the same objects.
  "sdk", "types",
];

export const ENTRY_FILE = "src/main.js";
export const STYLES_FILE = "styles.css";