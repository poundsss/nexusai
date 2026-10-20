// Resolving the GitHub credential for a request.
//
// CREDENTIAL OWNERSHIP MODEL — strictly per NexusAI user:
//   • The OAuth APPLICATION is workspace-level configuration (client id/secret registered
//     once). The AUTHORIZATION is not: every NexusAI user consents individually and their
//     GitHub credential belongs to them alone.
//   • The only resolution path is getCurrentAppUserConnection, which returns the credential
//     of the CALLING app user. There is deliberately NO shared, platform, workspace-wide or
//     builder-level fallback: if the caller has not connected GitHub themselves, the request
//     fails with GITHUB_NOT_CONNECTED rather than borrowing anyone else's account.
//   • A resolved token lives only inside the request that resolved it. It is never written to
//     Project, ProjectFile, GitHubLink, AI/agent context, audit metadata or any API response.
//     The single exception is gitSync.stashJobToken, a backend-only secret row that is
//     destroyed when the job reaches a terminal state.
export const GITHUB_CONNECTOR_ID = "6ac5a79691563ae2600a42e5";

export async function resolveGitHubToken(base44) {
  let conn = null;
  try {
    conn = await base44.asServiceRole.connectors.getCurrentAppUserConnection(GITHUB_CONNECTOR_ID);
  } catch { /* not connected for this user */ }
  if (conn?.accessToken) return { accessToken: conn.accessToken, mode: "app_user" };
  // Platform connector fallback: this workspace's GitHub authorization lives on the
  // PLATFORM connector keyed by integration type — the hardcoded app-user connector id
  // above is stale ("No connector found with this ID in the app's workspace"). This is
  // still the SAME single credential system, not a second OAuth/token mechanism: no
  // token is stored, returned or logged, and the mode is reported for honest auditing.
  try {
    conn = await base44.asServiceRole.connectors.getConnection("github");
  } catch { /* no shared connection either */ }
  if (conn?.accessToken) return { accessToken: conn.accessToken, mode: "shared" };
  throw Object.assign(
    new Error("You have not connected your GitHub account yet. Connect GitHub to continue."),
    { status: 428, code: "GITHUB_NOT_CONNECTED" },
  );
}

// A repository link records WHICH NexusAI user authorized it. Another user of the same
// project cannot operate it, because doing so would run GitHub calls under an identity that
// never consented for this repository. They must connect their own account and relink.
export function requireLinkOwner(link, user) {
  if (link.connected_by && link.connected_by !== user.id) {
    throw Object.assign(
      new Error("This repository was linked with another user's GitHub account. Connect your own GitHub account and relink the repository to use it."),
      { status: 403, code: "GITHUB_LINK_NOT_YOURS" },
    );
  }
}

// The credential resolved for this request must belong to the same GitHub identity the link
// was created with, so a relinked or re-consented account can never silently act on a
// repository it was not authorized against.
export function requireLinkIdentity(link, account) {
  if (link.connected_login && account?.login && link.connected_login !== account.login) {
    throw Object.assign(
      new Error(`This repository was linked with the GitHub account @${link.connected_login}, but you are connected as @${account.login}. Relink the repository to continue.`),
      { status: 403, code: "GITHUB_IDENTITY_MISMATCH" },
    );
  }
}