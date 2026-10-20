// The documented backend Core namespace for generated functions:
// `base44.asServiceRole.integrations.Core.<Method>(params)`. Each method is a thin call into the
// ONE certified dispatcher (appIntegrations.handleAppIntegrations) with trigger "function", so
// billing, quotas, validation and scrubbing are exactly the frontend bridge's. The dispatcher is
// imported lazily because it imports the function executor itself (module cycle).
// NEXUSAI-DERIVED: UploadFile / UploadPrivateFile take { filename, content_base64, content_type }
// in the sandbox (no File objects exist there).
const CORE_METHODS = [
  "InvokeLLM", "GenerateImage", "UploadFile", "SendEmail", "ExtractDataFromUploadedFile",
  "UploadPrivateFile", "CreateFileSignedUrl", "GenerateVideo", "GenerateSpeech", "TranscribeAudio",
  "SendPushNotification",
];

export function createCoreServiceRole(client, { project, integrations = [], user = null, session = null, transport = "platform" }) {
  const core = {};
  for (const op of CORE_METHODS) {
    core[op] = async (args = {}) => {
      const { handleAppIntegrations } = await import("./appIntegrations.ts");
      return handleAppIntegrations(client.asServiceRole || client, {
        project, integrations, user, session, op, args: args || {}, transport, trigger: "function",
      });
    };
  }
  return core;
}
export { CORE_METHODS };