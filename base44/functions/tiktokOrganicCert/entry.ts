// Mocked TikTok ONLY; real scratch persistence and existing queue/auth/OAuth contracts.
// Never contacts TikTok, never uses live TikTok credentials, never publishes real content.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { tikTokSurface } from "../../shared/tiktokSurface.ts";
import { resolveOwnTikTokConnection } from "../../shared/tiktokConnection.ts";
import { TIKTOK_PROVIDER_ID, TIKTOK_PROVIDERS, validateTikTokRedirect } from "../../shared/tiktokOAuth.ts";
import { beginDelegatedOAuth, completeDelegatedOAuth, refreshDelegatedCredential } from "../../shared/delegatedOAuth.ts";
import { publishOwnTikTok, assertOwnTikTokReady } from "../../shared/tiktokPublishing.ts";
import { calendarSurface, executeViralityScheduleJob, executeViralityPublishJob } from "../../shared/socialCalendar.ts";
import { publishTikTok, PUBLISHERS } from "../../shared/socialPublish.ts";
import { PUBLISHABLE_PLATFORMS } from "../../shared/virality.ts";
import { decryptWithAad } from "../../shared/secretCrypto.ts";
import { createTikTokMock, mockTikTokSecrets, mockTikTokOAuthHttp, MOCK_TOKEN } from "../../shared/tiktokCertFixtures.ts";

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const h = createHarness();
  const svc = base44.asServiceRole;
  const projects = [], workspaces = [];
  // The real queue is exercised, but every scratch job is parked one day ahead so an
  // autonomous production worker cannot ever pick it up while this suite is running.
  const guarded = { entities: new Proxy(svc.entities, { get(target, name) {
    if (name !== "BackgroundJob") return target[name];
    return { filter: (...args) => svc.entities.BackgroundJob.filter(...args), create: (data) => svc.entities.BackgroundJob.create({ ...data, available_at: new Date(Date.now() + 86400000).toISOString() }) };
  } }) };
  try {
    const caller = await base44.auth.me();
    if (!caller || caller.role !== "admin") return Response.json({ error: "Admin certification only" }, { status: 403 });
    const stamp = Date.now();
    const workspace = await svc.entities.Workspace.create({ name: `tt-own-cert-${stamp}`, owner_id: caller.id, status: "active" }); workspaces.push(workspace.id);
    const project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `tt-own-cert-${stamp}`, status: "ready" }); projects.push(project.id);
    const other = await svc.entities.Project.create({ workspace_id: workspace.id, name: `tt-own-other-${stamp}` }); projects.push(other.id);
    const secrets = { resolveSecret: mockTikTokSecrets };
    const oauthCalls = [];
    const oauth = { ...secrets, http: mockTikTokOAuthHttp(oauthCalls, { scopes: "video.publish,video.list" }) };
    const beginInput = { action: "tiktok_oauth_begin" };
    const absent = await captureCall(() => tikTokSurface(guarded, project, caller, beginInput, { resolveSecret: async () => undefined }));
    h.check("missing client configuration refuses before OAuth/provider work", absent.code === "OAUTH_CLIENT_NOT_CONFIGURED" && oauthCalls.length === 0);
    h.check("TikTok static HTTPS callback forbids query parameters", (await captureCall(() => validateTikTokRedirect("https://fixture.invalid/cb?project=x"))).code === "TIKTOK_REDIRECT_INVALID");
    const flow = await tikTokSurface(guarded, project, caller, beginInput, oauth);
    const authUrl = new URL(flow.authorization_url);
    h.check("own app OAuth uses official URL, client_key, exact scope and static callback", authUrl.origin === "https://www.tiktok.com" && authUrl.pathname === "/v2/auth/authorize/" && authUrl.searchParams.get("client_key") === "mock_client_key" && !authUrl.searchParams.has("client_id") && authUrl.searchParams.get("scope") === "video.publish" && authUrl.searchParams.get("redirect_uri") === "https://fixture.invalid/oauth/callback");
    h.check("Web OAuth retains opaque single-use state and does not invent Web PKCE", /^[a-f0-9]{64}$/.test(flow.state) && !authUrl.searchParams.has("code_challenge"));
    const connected = await tikTokSurface(guarded, project, caller, { action: "tiktok_oauth_callback", state: flow.state, code: "mock_code" }, oauth);
    const form = oauthCalls[0].form;
    h.check("official token exchange: client_key, client_secret, code, static redirect; no client_id/verifier", form.client_key === "mock_client_key" && form.client_secret === "mock_client_secret" && form.code === "mock_code" && form.redirect_uri === flow.redirect_uri && !form.client_id && !form.code_verifier);
    h.check("open_id identity and comma-separated granted scopes are preserved", connected.external_subject === "mock_tiktok_open_id" && JSON.stringify(connected.scopes) === JSON.stringify(["video.publish", "video.list"]));
    h.check("OAuth replay is refused", (await captureCall(() => tikTokSurface(guarded, project, caller, { action: "tiktok_oauth_callback", state: flow.state, code: "mock_code" }, oauth))).code === "OAUTH_STATE_USED");
    const credential = (await svc.entities.DelegatedCredential.filter({ project_id: project.id, credential_id: connected.credential_id }, { limit: 1 })).items[0];
    h.check("tokens are encrypted at rest using the existing project/credential AAD", credential.encrypted_access_token.startsWith("enc:v1:") && await decryptWithAad(`delegated-credential:${project.id}:${credential.credential_id}`, credential.encrypted_access_token) === MOCK_TOKEN);
    h.check("OAuth responses contain metadata only, never access/refresh tokens", !JSON.stringify(connected).includes(MOCK_TOKEN) && !connected.access_token && !connected.refresh_token);
    const refreshCalls = [];
    await refreshDelegatedCredential(guarded, project, caller, credential.credential_id, { ...secrets, http: mockTikTokOAuthHttp(refreshCalls) });
    h.check("refresh uses TikTok client_key and provider-granted scopes, never a fabricated grant", refreshCalls[0].form.client_key === "mock_client_key" && refreshCalls[0].form.grant_type === "refresh_token" && !refreshCalls[0].form.client_id && !refreshCalls[0].form.scope);
    const refreshed = await svc.entities.DelegatedCredential.get(credential.id);
    h.check("refresh revalidates open_id and persists the latest granted scopes", JSON.stringify(refreshed.scopes) === JSON.stringify(["video.publish"]));
    const mock = createTikTokMock();
    const options = { fetch: mock.fetch };
    const future = new Date(stamp + 86400000).toISOString();
    const input = { action: "calendar_create", platform: "tiktok", body: "Fixture video caption", hashtags: ["fixture"], scheduled_at: future, video_url: "https://fixture.invalid/video.mp4", video_duration_sec: 20, tiktok_credential_id: connected.credential_id, tiktok_settings: { privacy_level: "SELF_ONLY", allow_duet: true }, consent: true, music_usage_confirmed: true };
    const cal = (data) => calendarSurface(guarded, project, workspace, caller, data, { tiktok: options });
    h.check("post consent is required before persistence", (await captureCall(() => cal({ ...input, consent: false }))).code === "TIKTOK_CONSENT_REQUIRED");
    h.check("privacy has no invented default", (await captureCall(() => cal({ ...input, tiktok_settings: {} }))).code === "TIKTOK_PRIVACY_INVALID");
    h.check("creator duration is enforced", (await captureCall(() => cal({ ...input, video_duration_sec: 301 }))).code === "TIKTOK_DURATION_INVALID");
    h.check("branded content cannot be private", (await captureCall(() => cal({ ...input, tiktok_settings: { privacy_level: "SELF_ONLY", brand_content_toggle: true } }))).code === "TIKTOK_DISCLOSURE_INVALID");
    const post = await cal(input);
    const stored = await svc.entities.ViralityScheduledPost.get(post.id);
    h.check("calendar persists media/settings and stamps authenticated user/consent server-side", stored.video_url === input.video_url && stored.tiktok_user_id === caller.id && !!stored.tiktok_consent_at && stored.tiktok_credential_id === connected.credential_id);
    h.check("editing content requires fresh consent", (await captureCall(() => cal({ action: "calendar_update", post_id: post.id, body: "Changed without consent" }))).code === "TIKTOK_CONSENT_REQUIRED");
    const foreignCredential = await captureCall(() => resolveOwnTikTokConnection(guarded, { ...stored, project_id: other.id }));
    h.check("credential isolation: another project cannot select this authorization", foreignCredential.code === "NO_CONNECTION");
    const viewer = { id: `tt-viewer-${stamp}` };
    await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, user_id: viewer.id, email: "tt-viewer@example.invalid", role: "viewer", status: "active" });
    h.check("viewer cannot authorize publishing", (await captureCall(() => resolveOwnTikTokConnection(guarded, { ...stored, tiktok_user_id: viewer.id }))).code === "INSUFFICIENT_ROLE");
    h.check("non-member cannot reach the project write surface", (await captureCall(() => loadAuthorizedProject(guarded, { id: "tt-foreign-member" }, project.id, "project.write"))).status === 403);
    const narrowMock = createTikTokMock();
    const narrow = await captureCall(() => assertOwnTikTokReady(guarded, stored, { fetch: narrowMock.fetch, getConnection: async () => ({ accessToken: MOCK_TOKEN, scopes: ["video.list"] }) }));
    h.check("missing video.publish refuses with zero provider calls", narrow.code === "PERMISSION_MISSING" && narrowMock.calls.length === 0);
    const range = { project_id: project.id, scheduled_from: future, scheduled_until: new Date(Date.parse(future) + 1).toISOString() };
    const scheduled = await executeViralityScheduleJob(guarded, range, { tiktok: options });
    const repeated = await executeViralityScheduleJob(guarded, range, { tiktok: options });
    h.check("capability verified TikTok reuses the existing idempotent social publish job", scheduled.created_workflows === 1 && repeated.reused_workflows === 1 && repeated.created_workflows === 0 && await svc.entities.BackgroundJob.count({ project_id: project.id, job_type: "virality.publish" }) === 1);
    const publishers = { ...PUBLISHERS, tiktok: (s, r) => publishTikTok(s, r, options) };
    const outcome = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: post.id }, { publishers });
    const after = await svc.entities.ViralityScheduledPost.get(post.id);
    h.check("documented creator -> video/init -> status publishes only after PUBLISH_COMPLETE", outcome.status === "posted" && after.status === "posted" && after.tiktok_publish_id === "mock_publish_operation_1" && after.tiktok_post_ref === "900000000000000001");
    const init = mock.calls.find((call) => call.path.endsWith("video/init/"));
    h.check("provider payload uses PULL_FROM_URL and creator-enforced interaction opt-ins", init.body.source_info.source === "PULL_FROM_URL" && init.body.source_info.video_url === input.video_url && init.body.post_info.title === "Fixture video caption\n\n#fixture" && init.body.post_info.privacy_level === "SELF_ONLY" && init.body.post_info.disable_duet === true && init.body.post_info.disable_comment === true);
    const dedup = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: post.id }, { publishers });
    h.check("already-published dedup never initializes a second provider operation", dedup.skipped === "already_published" && mock.initCount() === 1);
    h.check("cross-project publish dispatch is post_gone", (await executeViralityPublishJob(guarded, { project_id: other.id, post_id: post.id }, { publishers })).skipped === "post_gone");
    const processingMock = createTikTokMock({ status: "PROCESSING_DOWNLOAD" });
    const processingPost = await cal(input);
    const processingPublishers = { ...PUBLISHERS, tiktok: (s, r) => publishOwnTikTok(s, r, { fetch: processingMock.fetch }) };
    const processing = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: processingPost.id }, { publishers: processingPublishers });
    const processRow = await svc.entities.ViralityScheduledPost.get(processingPost.id);
    h.check("init acceptance persists publish_id but remains publishing, not posted", processing.status === "publishing" && processRow.status === "publishing" && !!processRow.tiktok_publish_id);
    h.check("processing enqueues a bounded status-only continuation in the SAME queue/job type", await svc.entities.BackgroundJob.count({ project_id: project.id, idempotency_key: `virality:publish:${processRow.id}:tiktok-status:mock_publish_operation_1:1` }) === 1);
    processingMock.state.status = "PUBLISH_COMPLETE";
    const completed = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: processRow.id }, { publishers: processingPublishers });
    h.check("continuation polls saved publish_id and never uploads twice", completed.status === "posted" && processingMock.initCount() === 1);
    const approvalMock = createTikTokMock({ initError: "unaudited_client_can_only_post_to_private_accounts" });
    const approvalPost = await cal(input);
    const deniedApproval = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: approvalPost.id }, { publishers: { ...PUBLISHERS, tiktok: (s, r) => publishOwnTikTok(s, r, { fetch: approvalMock.fetch }) } });
    h.check("TikTok app review/audit refusal is terminal; no simulated approval", deniedApproval.status === "failed" && approvalMock.initCount() === 1);
    const lostMock = createTikTokMock({ initThrows: true });
    const lostPost = await cal(input);
    const lostPublishers = { ...PUBLISHERS, tiktok: (s, r) => publishOwnTikTok(s, r, { fetch: lostMock.fetch }) };
    const lost = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: lostPost.id }, { publishers: lostPublishers });
    const noRetry = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: lostPost.id }, { publishers: lostPublishers });
    h.check("ambiguous init outcome stays unknown and is never resubmitted", lost.status === "publish_outcome_unknown" && noRetry.skipped === "already_publish_outcome_unknown" && lostMock.initCount() === 1);
    const failedMock = createTikTokMock({ status: "FAILED" });
    const failedPost = await cal(input);
    const failed = await executeViralityPublishJob(guarded, { project_id: project.id, post_id: failedPost.id }, { publishers: { ...PUBLISHERS, tiktok: (s, r) => publishOwnTikTok(s, r, { fetch: failedMock.fetch }) } });
    h.check("provider FAILED status never maps to posted", failed.status === "failed");
    const raw = await beginDelegatedOAuth(guarded, project, caller, { provider_id: TIKTOK_PROVIDER_ID, redirect_uri: "https://fixture.invalid/oauth/callback", providers: TIKTOK_PROVIDERS }, secrets);
    const unknownScopes = await completeDelegatedOAuth(guarded, project, caller, { state: raw.state, code: "mock_code", providers: TIKTOK_PROVIDERS }, { ...secrets, http: mockTikTokOAuthHttp([], { scopes: "", subject: "mock_ungranted_account" }) });
    h.check("absent granted scopes never fall back to requested video.publish", unknownScopes.scopes.length === 0);
    const revokeCalls = [];
    await tikTokSurface(guarded, project, caller, { action: "tiktok_disconnect", credential_id: connected.credential_id }, { ...secrets, http: mockTikTokOAuthHttp(revokeCalls) });
    h.check("disconnect uses official revoke wire format and existing local revocation", revokeCalls[0].form.client_key === "mock_client_key" && !revokeCalls[0].form.client_id && !revokeCalls[0].form.token_type_hint && (await svc.entities.DelegatedCredential.get(credential.id)).status === "revoked");
    h.check("shared read/list connector and unconditional publisher registry remain untouched", !PUBLISHABLE_PLATFORMS.includes("tiktok") && PUBLISHERS.tiktok === publishTikTok && ["instagram", "facebook", "linkedin", "x"].every((platform) => typeof PUBLISHERS[platform] === "function"));
    return Response.json({ ...h.summary(), provider: "mocked", persistence: "real scratch records", live: "not attempted: no approved app credentials", real_content_published: false });
  } catch (error) {
    return Response.json({ ...h.summary(), ok: false, error: String(error.message), provider: "mocked", real_content_published: false }, { status: 500 });
  } finally {
    for (const projectId of projects) {
      for (const entity of ["BackgroundJob", "ViralityScheduledPost", "DelegatedCredential", "AppAuthToken", "AppIdentity", "ProjectSecret", "AuditLog"]) await purgeBy(svc, entity, { project_id: projectId });
      await svc.entities.Project.delete(projectId).catch(() => {});
    }
    for (const workspaceId of workspaces) {
      await purgeBy(svc, "WorkspaceMember", { workspace_id: workspaceId });
      await purgeBy(svc, "RateLimitBucket", { workspace_id: workspaceId });
      await svc.entities.Workspace.delete(workspaceId).catch(() => {});
    }
  }
}