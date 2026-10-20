// P-9.11K certification — agent-scoped user connectors for deployed in-app agents.
//
// Drives the REAL shipping modules (agentResource / appAgentRuntime / appConnectors /
// delegatedOAuth / secretCrypto / the canonical ledger paths) — no scripted model provider is
// needed because the connect-link op runs NO model turn. Certifies the approved minimal
// boundary of the Base44-documented behavior ("the agent can create OAuth connect links so
// each person can authorize access to their own account ... directly from a conversation"):
//   • resource contract: the owned `connectors` key parses, round-trips and fails closed
//     (invalid name / duplicate / over-cap / cross-resource existence);
//   • runtime op: anonymous fail-closed, ghost agent, toggle-off (not enabled on the agent),
//     unknown-to-the-registry connector, Free-plan (Builder+ entitlement) refusal;
//   • state semantics through the EXISTING #31G machinery verbatim: single-use state bound to
//     the conversation user, PKCE S256, cross-user / cross-project / garbage / replay refusals,
//     encrypted AAD-bound token persistence;
//   • redaction: no client secret, victim secret, raw token or PKCE verifier in any response,
//     row or audit entry;
//   • billing invariants: the op moves no credits, opens no AI operation and persists no
//     conversation/message rows.
// Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingPlan, makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { parseAgentDocument, agentDocumentContent, validateAgentReferences, MAX_AGENT_CONNECTORS } from "../../shared/agentResource.ts";
import { parseConnectorDocument } from "../../shared/connectorResource.ts";
import { agentFilePath, connectorFilePath } from "../../shared/base44Layout.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { completeDelegatedOAuth } from "../../shared/delegatedOAuth.ts";
import { buildDelegatedProviders } from "../../shared/appConnectors.ts";
import { appAgentPace, makeAgentPoolTools, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb } from "../../shared/appAgentSuiteHelpers.ts";

const AUTH_HOST = "oauth.p911k.test";
const CLIENT_ID = "p911k_client_id";
const CLIENT_SECRET = "p911k_client_secret_never_leak";
const VICTIM_NAME = "P911K_VICTIM_SECRET";
const VICTIM_VALUE = "p911k_victim_secret_value_never_leak";
const ACCESS_TOKEN = "at_p911k_abc123neverleak";
const REFRESH_TOKEN = "rt_p911k_xyz789neverleak";

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every caller-visible value — leakage is asserted over all of it

  const pace = appAgentPace;
  const db = makeAgentSuiteDb(rawDb, pace);
  const pools = makeAgentPoolTools(db, stamp, "p911k");
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };

  // The connector declaration exactly as a deployment's payload carries it (parsed through the
  // REAL connector resource contract, so delegated_oauth normalization is exercised).
  const connectorDocText = JSON.stringify({
    name: "calConn", type: "http", description: "P-9.11K delegated connector",
    base_url: "https://api.p911k.test/v1", auth: { type: "none" },
    operations: [{ name: "ping", method: "GET", path: "/me" }],
    delegated_oauth: {
      authorization_endpoint: `https://${AUTH_HOST}/authorize`,
      token_endpoint: `https://${AUTH_HOST}/token`,
      revoke_endpoint: `https://${AUTH_HOST}/revoke`,
      client_id_secret: "P911K_CLIENT_ID",
      client_secret_secret: "P911K_CLIENT_SECRET",
      scopes: ["read", "write"],
      pkce: true,
    },
  }, null, 2);
  const parsedConn = parseConnectorDocument(connectorFilePath("calConn"), connectorDocText);

  // The declared agent documents, parsed through the REAL agent contract.
  const agentDoc = (name, extra = {}) => JSON.stringify({
    name, display_name: name, description: "test agent", instructions: "Answer briefly.",
    tools: [], skills: [], model_tier: "fast", max_steps: 3, ...extra,
  }, null, 2);
  const parseAgent = (name, extra = {}) => parseAgentDocument(agentFilePath(name), agentDoc(name, extra));
  const helper = parseAgent("helper", { connectors: ["calConn"] });
  const open = parseAgent("open", { allow_anonymous_access: true, connectors: ["calConn"] });
  const silent = parseAgent("silent", {});
  const ghosty = parseAgent("ghosty", { connectors: ["ghostConn"] });

  const callOp = async (project, payload, user, args, anonymous = null, options = {}) => {
    await pace(2000);
    const cap = await captureCall(() => handleAppAgent(client, { project, payload, user, anonymous, op: "connect_link", args, options }));
    responses.push(cap);
    return cap;
  };

  try {
    const caller = await createClientFromRequest(req).auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    // --- 1. Resource contract (pure; the REAL parser, no fixtures) -------------------------
    h.check("1a. connector declaration parses through the REAL connector contract", parsedConn.ok && parsedConn.connector.name === "calConn" && !!parsedConn.connector.delegated_oauth, parsedConn.ok ? parsedConn.connector.name : parsedConn.error);
    h.check("1b. the owned `connectors` key parses through the REAL agent contract", helper.ok && JSON.stringify(helper.agent.connectors) === JSON.stringify(["calConn"]), helper.ok ? JSON.stringify(helper.agent.connectors) : helper.error);
    const rt = parseAgentDocument(agentFilePath("helper"), agentDocumentContent(helper.agent));
    h.check("1c. the canonical document round-trips connectors", rt.ok && JSON.stringify(rt.agent.connectors) === JSON.stringify(["calConn"]), rt.ok ? JSON.stringify(rt.agent.connectors) : rt.error);
    h.check("1d. an agent without connectors emits no key (byte-identical round-trip)", silent.ok && !/"connectors"/.test(agentDocumentContent(silent.agent)), silent.ok ? "no key emitted" : silent.error);
    h.check("1e. an invalid connector name refuses the document", !parseAgent("bad1", { connectors: ["Bad-Name"] }).ok, "Bad-Name");
    h.check("1f. a non-array connectors value refuses the document", !parseAgent("bad2", { connectors: "calConn" }).ok, "string");
    h.check("1g. a duplicate connector refuses the document", !parseAgent("bad3", { connectors: ["calConn", "calConn"] }).ok, "calConn twice");
    h.check("1h. more than the cap refuses the document",
      !parseAgent("bad4", { connectors: Array.from({ length: MAX_AGENT_CONNECTORS + 1 }, (_, i) => `c${i}`) }).ok, `cap ${MAX_AGENT_CONNECTORS}`);
    const agentFiles = [{ path: agentFilePath("helper"), content: agentDoc("helper", { connectors: ["calConn"] }) }];
    const withConn = validateAgentReferences([...agentFiles, { path: connectorFilePath("calConn"), content: connectorDocText }]);
    const withoutConn = validateAgentReferences(agentFiles);
    h.check("1i. cross-resource check passes when the project declares the connector", withConn.ok && withConn.missingConnectors.length === 0, JSON.stringify(withConn.errors));
    h.check("1j. cross-resource check refuses a connector the project does not declare",
      !withoutConn.ok && withoutConn.missingConnectors.length === 1 && withoutConn.missingConnectors[0].connector === "calConn", JSON.stringify(withoutConn.errors));

    // --- fixtures: Builder+ workspace (A) and a subscription-less Free workspace (F) --------
    const plan = await makeBillingPlan(db, created, `p911k${stamp}`, { tier_rank: 7, price_cents: 5000 });
    const A = await makeBillingWorkspace(db, created, `p911ka${stamp}`, { plan }, stamp);
    const F = await makeBillingWorkspace(db, created, `p911kf${stamp}`, { plan: null }, stamp);
    for (const f of [A, F]) wsIds.push(f.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 200);
    await pools.grant(A.ws.id, "integration", 100);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911k-proj-a-${stamp}`, slug: `p911ka-${stamp}` });
    const projF = await db.entities.Project.create({ workspace_id: F.ws.id, name: `p911k-proj-f-${stamp}`, slug: `p911kf-${stamp}` });
    projectIds.push(projA.id, projF.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p911k.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p911k.test", display_name: "A2", email_verified: true });
    const userF1 = await createPasswordlessUser(db, projF, { email: "f1@p911k.test", display_name: "F1", email_verified: true });
    await setProjectSecret(db, projA, "P911K_CLIENT_ID", CLIENT_ID);
    await setProjectSecret(db, projA, "P911K_CLIENT_SECRET", CLIENT_SECRET);
    await setProjectSecret(db, projA, VICTIM_NAME, VICTIM_VALUE);
    await pace(1500);
    const resolveA = projectSecretResolver(db, projA);
    const registry = buildDelegatedProviders([parsedConn.connector]);
    const payloadA = { agents: [helper.agent, open.agent, silent.agent, ghosty.agent], connectors: [parsedConn.connector], entities: [], functions: [], integrations: [] };
    const payloadF = { agents: [helper.agent], connectors: [parsedConn.connector], entities: [], functions: [], integrations: [] };

    // Billing/persistence baselines — the op must move none of them.
    const msg0 = await pools.msgOf(A.ws.id);
    const int0 = await pools.intOf(A.ws.id);
    const ledger0 = (await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "created_date", 500).catch(() => [])).length;
    const aiops0 = (await db.entities.AIOperation.filter({ workspace_id: A.ws.id }, "created_date", 500).catch(() => [])).length;
    const records0 = (await db.entities.AppRecord.filter({ project_id: projA.id }, "created_date", 500).catch(() => [])).length;
    await pace(1500);

    // --- 2. Runtime op: fail-closed surface -------------------------------------------------
    const anon1 = await callOp(projA, payloadA, null, { name: "helper", connector: "calConn" }, { user: { id: "anon-user-1" } });
    h.check("2a. an anonymous caller is refused (no account to bind an OAuth state to)",
      anon1.threw && anon1.code === "AGENT_AUTH_REQUIRED" && anon1.status === 401, `${anon1.code || "no throw"}`);
    const anon2 = await callOp(projA, payloadA, null, { name: "open", connector: "calConn" }, { user: { id: "anon-user-2" } });
    h.check("2b. an anonymous caller is refused even for an anonymous-access agent",
      anon2.threw && anon2.code === "AGENT_AUTH_REQUIRED" && anon2.status === 401, `${anon2.code || "no throw"}`);
    const ghostAgent = await callOp(projA, payloadA, userA1, { name: "nobody", connector: "calConn" });
    h.check("2c. a ghost agent is refused", ghostAgent.threw && ghostAgent.code === "AGENT_NOT_FOUND", `${ghostAgent.code || "no throw"}`);
    const disabled = await callOp(projA, payloadA, userA1, { name: "silent", connector: "calConn" });
    h.check("2d. a connector in the registry but NOT enabled on the agent is refused (toggle-off parity)",
      disabled.threw && disabled.code === "AGENT_CONNECTOR_NOT_DECLARED" && disabled.status === 403, `${disabled.code || "no throw"}`);
    const unknown = await callOp(projA, payloadA, userA1, { name: "ghosty", connector: "ghostConn" });
    h.check("2e. a connector enabled on the agent but absent from the deployment registry fails closed",
      unknown.threw && unknown.code === "CONNECTOR_NOT_FOUND" && unknown.status === 404, `${unknown.code || "no throw"}`);
    const freePlan = await callOp(projF, payloadF, userF1, { name: "helper", connector: "calConn" });
    h.check("2f. a Free workspace is refused (Builder+ entitlement, enforced server-side)",
      freePlan.threw && freePlan.code === "PLAN_NOT_ENTITLED" && freePlan.status === 403, `${freePlan.code || "no throw"}`);

    // --- 3. Connect-link generation and state semantics (EXISTING #31G machinery) -----------
    const link1 = await callOp(projA, payloadA, userA1, { name: "helper", connector: "calConn" }, null,
      { connectorsCallbackUrl: "https://runtime.p911k.test/app/p/oauth/callback" });
    h.check("3a. the op generates a connect link for the conversation user",
      !link1.threw && link1.value.agent === "helper" && link1.value.connector === "calConn" && !!link1.value.authorization_url && link1.value.pkce === true,
      link1.threw ? `${link1.code}` : link1.value.authorization_url);
    const u = link1.threw ? new URL("https://invalid.test/") : new URL(link1.value.authorization_url);
    h.check("3b. the authorization URL is the declared flow (client_id, scopes, PKCE S256, redirect)",
      !link1.threw && `${u.origin}${u.pathname}` === `https://${AUTH_HOST}/authorize`
        && u.searchParams.get("client_id") === CLIENT_ID
        && u.searchParams.get("scope") === "read write"
        && u.searchParams.get("response_type") === "code"
        && !!u.searchParams.get("code_challenge") && u.searchParams.get("code_challenge_method") === "S256"
        && u.searchParams.get("redirect_uri") === "https://runtime.p911k.test/app/p/oauth/callback?connector=calConn",
      link1.threw ? `${link1.code}` : link1.value.authorization_url);
    h.check("3c. no client secret ever enters the URL",
      !link1.threw && !link1.value.authorization_url.includes(CLIENT_SECRET) && !link1.value.authorization_url.includes("client_secret"), "");
    const state1 = u.searchParams.get("state") || "";
    const stateRows1 = await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "delegated_oauth_state" }, "-created_date", 10).catch(() => []);
    h.check("3d. the single-use state is bound to the conversation user and the declared provider",
      /^[a-f0-9]{64}$/.test(state1) && stateRows1.length >= 1 && stateRows1[0].app_user_id === userA1.id
        && stateRows1[0].status === "pending" && stateRows1[0].data?.provider_id === "calConn"
        && typeof stateRows1[0].data?.pkce_verifier === "string",
      JSON.stringify({ state_ok: /^[a-f0-9]{64}$/.test(state1), owner: stateRows1[0]?.app_user_id, provider: stateRows1[0]?.data?.provider_id }));

    const tokenHttp = async () => ({ ok: true, status: 200, headers: {}, body: {
      access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, scope: "read write",
      sub: "ext-sub-p911k", email: "ext@p911k.test", profile: { name: "Ext P911K" },
    } });
    await h.expectThrow("3e. a state issued to user A1 cannot be completed by user A2 (cross-user fail-closed)",
      () => completeDelegatedOAuth(db, projA, userA2, { state: state1, code: "c1", providers: registry }, { resolveSecret: resolveA, http: tokenHttp }), "OAUTH_STATE_MISMATCH");

    const link2 = await callOp(projA, payloadA, userA1, { name: "helper", connector: "calConn" });
    const state2 = link2.threw ? "" : new URL(link2.value.authorization_url).searchParams.get("state") || "";
    await h.expectThrow("3f. a state issued in project A cannot be completed in project F (cross-project fail-closed)",
      () => completeDelegatedOAuth(db, projF, userF1, { state: state2, code: "c1", providers: registry }, { resolveSecret: resolveA, http: tokenHttp }), "OAUTH_STATE_INVALID");
    await h.expectThrow("3g. a garbage state is refused (tampering fail-closed)",
      () => completeDelegatedOAuth(db, projA, userA1, { state: "0".repeat(64), code: "c1", providers: registry }, { resolveSecret: resolveA, http: tokenHttp }), "OAUTH_STATE_INVALID");

    const link3 = await callOp(projA, payloadA, userA1, { name: "helper", connector: "calConn" });
    const state3 = link3.threw ? "" : new URL(link3.value.authorization_url).searchParams.get("state") || "";
    const done = await captureCall(() => completeDelegatedOAuth(db, projA, userA1, { state: state3, code: "auth-code-1", providers: registry }, { resolveSecret: resolveA, http: tokenHttp }));
    responses.push(done);
    h.check("3h. the conversation user completes the flow and receives metadata only",
      !done.threw && done.value.status === "active" && !!done.value.credential_id && !JSON.stringify(done.value).includes(ACCESS_TOKEN) && !JSON.stringify(done.value).includes(REFRESH_TOKEN),
      done.threw ? `${done.code}: ${done.message}` : done.value.credential_id);
    await h.expectThrow("3i. a replayed state is refused (single use)",
      () => completeDelegatedOAuth(db, projA, userA1, { state: state3, code: "auth-code-1", providers: registry }, { resolveSecret: resolveA, http: tokenHttp }), "OAUTH_STATE_USED");
    const creds = await db.entities.DelegatedCredential.filter({ project_id: projA.id }, "-created_date", 5).catch(() => []);
    h.check("3j. tokens persist ENCRYPTED (AAD-bound), never in the clear",
      creds.length === 1 && typeof creds[0].encrypted_access_token === "string" && creds[0].encrypted_access_token !== ACCESS_TOKEN
        && !JSON.stringify(creds[0]).includes(ACCESS_TOKEN) && !JSON.stringify(creds[0]).includes(REFRESH_TOKEN)
        && JSON.stringify(creds[0].scopes) === JSON.stringify(["read", "write"]),
      `rows=${creds.length}`);

    // --- 4. Redaction: nothing secret reaches any response, row or audit entry -------------
    const allStates = await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "delegated_oauth_state" }, "-created_date", 50).catch(() => []);
    const audited = await db.entities.AuditLog.filter({ project_id: projA.id }, "-created_date", 100).catch(() => []);
    const blob = JSON.stringify({ responses, states: allStates, creds, audited });
    const verifiers = allStates.map((r) => r.data?.pkce_verifier).filter(Boolean);
    const responseBlob = JSON.stringify(responses);
    h.check("4a. no client secret, victim secret, raw token or ciphertext value leaks anywhere",
      !blob.includes(CLIENT_SECRET) && !blob.includes(VICTIM_VALUE) && !blob.includes(ACCESS_TOKEN) && !blob.includes(REFRESH_TOKEN),
      `blob=${blob.length} chars scanned`);
    h.check("4b. no PKCE verifier ever reaches a response",
      verifiers.length > 0 && !verifiers.some((v) => responseBlob.includes(v)), `verifiers=${verifiers.length}`);

    // --- 5. Billing / persistence invariants: the op is free and side-effect-free -----------
    const msg1 = await pools.msgOf(A.ws.id);
    const int1 = await pools.intOf(A.ws.id);
    const ledger1 = (await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "created_date", 500).catch(() => [])).length;
    const aiops1 = (await db.entities.AIOperation.filter({ workspace_id: A.ws.id }, "created_date", 500).catch(() => [])).length;
    const records1 = (await db.entities.AppRecord.filter({ project_id: projA.id }, "created_date", 500).catch(() => [])).length;
    h.check("5a. the op moves no message or integration credits (no invented tariff)",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}, int ${int0}→${int1}`);
    h.check("5b. the op opens no ledger entry and no AI operation",
      ledger1 === ledger0 && aiops1 === aiops0, `ledger ${ledger0}→${ledger1}, aiops ${aiops0}→${aiops1}`);
    h.check("5c. the op persists no conversation or message rows",
      records1 === records0, `app_records ${records0}→${records1}`);

    return harnessResponse(h);
  } catch (error) {
    const s = h.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911k-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^billing-test p911k" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppIdentity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppSession.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.ProjectSecret.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AuditLog.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.DelegatedCredential.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p911k" } }).catch(() => {});
  }
}