import { describeTools } from "./tools.ts";
import { RUNTIME_EXPORTS } from "./runtimeExports.ts";
import { DESIGN_SCHEMA } from "./designSystem.ts";

// Entity fields must be a LIST with declared item properties. A free-form map
// ({ type: "object", additionalProperties: true }) comes back empty under
// structured-output enforcement, silently producing field-less entities.
const FIELD_LIST_SCHEMA = {
  type: "array",
  description: "The entity's fields, in order.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "Field name, e.g. company_name" },
      type: { type: "string", enum: ["string", "text", "number", "boolean", "date", "enum"] },
      required: { type: "boolean" },
      enum: { type: "array", items: { type: "string" }, description: "Allowed values — required when type is 'enum'." },
      description: { type: "string" },
    },
    required: ["name", "type", "required"],
    additionalProperties: false,
  },
};

// Integration definitions, declared structurally by the planner. Metadata only: the
// credential is a project-secret NAME reference; no field can carry a value.
// The item schema is intentionally loose (only `name` required) to keep Claude's structured-
// output grammar small; the full structure is described in the description and validated by
// the integration tool at apply time.
const INTEGRATION_LIST_SCHEMA = {
  type: "array",
  description: "External API integrations to create or fully redefine. Each item: { name (lowerCamelCase), type ('http'|'mcp'), description, base_url (http), server_url (mcp), openapi_url (optional OpenAPI JSON/YAML URL to import ops), auth: { type ('none'|'api_key'|'bearer'|'oauth2'), secret (NAME), in ('header'|'query'), header_name, grant ('client_credentials'|'refresh_token'), token_url, client_id, client_secret (NAME), scope }, retry: { max_attempts, retry_on_status:[], backoff_ms }, operations: [{ name, method ('GET'|'POST'|'PUT'|'PATCH'|'DELETE'), path (with {param} placeholders), description, parameters: [{ name, in ('path'|'query'|'header'), required, type, description }], body_fields: [{ name, type, required, description }], idempotent (bool, http only), tool (string, mcp only), read_only (bool, mcp only) }] }. An existing name is replaced by this definition, so include every operation it must keep. Omit when the change needs no external API. secret/client_secret are project secret NAMEs, never values.",
  items: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
};

// Phase A: plan + entity declarations + file manifest (small output, fast).
export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "Short, plain-language summary for the user. No code." },
    plan: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    request_more_context: { type: "boolean", description: "true when you need read_actions results before you can plan the files." },
    read_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string", enum: ["read_file", "search_project", "list_mcp_connections", "mcp_call"] },
          input: {
            type: "object",
            properties: { path: { type: "string" }, query: { type: "string" }, connection: { type: "string", description: "mcp_call: MCP connection name" }, tool: { type: "string", description: "mcp_call: MCP tool name" }, arguments_json: { type: "string", description: "mcp_call: the tool's arguments as JSON text" } },
            required: [],
            additionalProperties: false,
          },
        },
        required: ["tool", "input"],
        additionalProperties: false,
      },
    },
    entities: {
      type: "array",
      description: "Every entity the app needs (new or changed). Existing unchanged entities may be omitted.",
      items: {
        type: "object",
        properties: { name: { type: "string" }, fields: FIELD_LIST_SCHEMA },
        required: ["name", "fields"],
        additionalProperties: false,
      },
    },
    secrets: {
      type: "array",
      description: "Credentials the app requires, by NAME only. Never include a value. Omit when the change needs no credential.",
      items: {
        type: "object",
        properties: { name: { type: "string", description: "UPPER_SNAKE_CASE, e.g. WEATHER_API_KEY" }, description: { type: "string" }, required: { type: "boolean" } },
        required: ["name", "description", "required"],
        additionalProperties: false,
      },
    },
    integrations: INTEGRATION_LIST_SCHEMA,
    design: DESIGN_SCHEMA,
    files: {
      type: "array",
      description: "Every file to create, rewrite, patch or delete. Untouched files must NOT be listed. Never list integrations/*.json — declare those under 'integrations'.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["create", "rewrite", "patch", "delete", "move"] },
          to: { type: "string", description: "For action 'move': the new path. Imports across the project and server.<name> call sites are rewritten automatically." },
          purpose: { type: "string", description: "What this file does; for components describe the props it accepts." },
          exports: { type: "array", items: { type: "string" }, description: "e.g. ['default CustomerList']" },
          change: { type: "string", description: "For patch/rewrite: precisely what must change." },
        },
        required: ["path", "action"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "plan", "request_more_context", "files"],
  additionalProperties: false,
};

// Discuss mode: answer-oriented contract. Deliberately has NO plan/files/entities fields —
// discuss must never be able to express a mutation plan.
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The direct answer to the user's question, in markdown. Facts first; no numbered plan of how you will answer." },
    context_used: { type: "array", items: { type: "string" }, description: "The project artifacts the answer is based on, e.g. 'src/pages/Customers.js', 'entity Customer', 'function reportSummary'." },
    request_more_context: { type: "boolean", description: "true only when you cannot answer without reading a file listed as not included." },
    read_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string", enum: ["read_file", "search_project", "list_mcp_connections", "mcp_call"] },
          input: {
            type: "object",
            properties: { path: { type: "string" }, query: { type: "string" }, connection: { type: "string", description: "mcp_call: MCP connection name" }, tool: { type: "string", description: "mcp_call: MCP tool name" }, arguments_json: { type: "string", description: "mcp_call: the tool's arguments as JSON text" } },
            required: ["path", "query", "connection", "tool", "arguments_json"],
            additionalProperties: false,
          },
        },
        required: ["tool", "input"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "context_used", "request_more_context", "read_actions"],
  additionalProperties: false,
};

export function buildAnswerPrompt() {
  return `You are the analyst of an AI application builder. You answer questions about ONE existing project, and you never modify it.

MODE: DISCUSS — read-only. You cannot create, change or delete anything. Your only output is the answer itself.

${RUNTIME_GUIDE}

HOW TO ANSWER:
- Answer the question DIRECTLY, from the PROJECT CONTEXT given to you (file index, entities, backend functions, integrations, secret names, file contents). State the facts.
- NEVER reply with a plan, a numbered list of steps you intend to take, an analysis procedure, or tool instructions. "1. Identify the pages 2. List the functions" is a WRONG answer; the actual list of pages and functions is the RIGHT answer.
- Factual questions about the project (which pages, which entities and fields, which backend functions, which integrations, which secrets are required, how a feature currently works) are answered from the context, quoting real names, paths and fields.
- If the answer is genuinely not in the project state, say plainly that it is not configured or not present. Never invent a page, entity, function, integration, credential or library that is not there, and never state a secret's value (you never receive one).
- When the user asks how something COULD be built or changed, describe the approach and tradeoffs in prose — that is an explanation, not a work order, and nothing is executed.
- Be concise and concrete: short markdown, lists for lists, no code dumps unless a small snippet is the clearest answer.
- List the artifacts you relied on in context_used.
- Only set request_more_context=true (with read_actions) when the file you need is listed as not included and you truly cannot answer without it.

MCP CONNECTIONS (account-level builder infrastructure, listed in the context):
- Questions about which MCP connections or MCP tools exist, their status, server or credentials are answered DIRECTLY from that context — names, servers, statuses and tool names, never a plan.
- You may read live data with a read_action { tool: "mcp_call", input: { connection, tool, arguments_json } } ONLY for tools marked [read-only]; anything else is refused, because discuss mode must cause no external side effect. When a tool is not read-only, answer from metadata and say the call was not made.
- Never invent an MCP connection, tool or result, and never state a credential value.`;
}

export const FILE_SCHEMA = { type: "object", properties: { content: { type: "string", description: "Complete file content." } }, required: ["content"], additionalProperties: false };
export const PATCH_SCHEMA = {
  type: "object",
  properties: { patches: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"], additionalProperties: false } } },
  required: ["patches"],
  additionalProperties: false,
};

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "Short, plain-language summary for the user. No code." },
    plan: { type: "array", items: { type: "string" }, description: "Numbered implementation steps grounded in the actual project." },
    assumptions: { type: "array", items: { type: "string" } },
    request_more_context: { type: "boolean", description: "true when you only issued read tools and need their results before writing." },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string" },
          input: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              find: { type: "string" },
              replace: { type: "string" },
              query: { type: "string" },
              name: { type: "string" },
              fields: FIELD_LIST_SCHEMA,
            },
            required: ["path", "content", "find", "replace", "query", "name", "fields"],
            additionalProperties: false,
          },
        },
        required: ["tool", "input"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "plan", "assumptions", "request_more_context", "actions"],
  additionalProperties: false,
};

export const RUNTIME_GUIDE = `
RUNTIME (fixed — you cannot change it):
- Apps are plain ES modules. NO JSX, NO TypeScript, NO npm packages, NO bundler. Exactly two import kinds are allowed:
  import { ... } from 'runtime'        (platform runtime)
  import X from './components/X.js'    (relative project file, ALWAYS with the .js extension)
- 'runtime' exports: ${RUNTIME_EXPORTS.join(", ")}.
- UI = Preact + htm tagged templates:
    html\`<div class="p-4 text-sm">\${title}</div>\`
    Components: html\`<\${Card} title="Hi" onSelect=\${fn}>children<//>\`   (self-closing: html\`<\${Card} />\`)
    Attributes: class (NOT className), onClick, onInput, onSubmit, value, checked, disabled.
    Lists: \${items.map(i => html\`<li key=\${i.id}>\${i.name}</li>\`)}   Conditionals: \${cond && html\`...\`}
    Components are plain functions receiving props; hooks (useState/useEffect/...) come from 'runtime'.
- Styling: Tailwind utility classes are available. styles.css holds any extra CSS.
- Entry file src/main.js MUST exist and render App exactly like:
    import { html, render } from 'runtime';
    import App from './App.js';
    render(html\`<\${App} />\`, document.getElementById('app'));
- Routing (in-memory): const path = useRoute();  → '/', '/customers', '/customers/abc123'.
    navigate('/customers');   html\`<\${Link} href="/customers" class="...">Customers<//>\`
    Match routes in src/App.js by inspecting path (e.g. path.startsWith('/customers/')).
- Database: declare entities with create_entity BEFORE using them. Then, all async:
    db.Customer.list(sort?, limit?)                       → array of records
    db.Customer.filter(query, sort?, limit?, skip?)       query: { company: 'Acme' } exact match, or operators { name: { $contains: 'jo' } }, { $in: [...] }, { $gt/$gte/$lt/$lte }, { $ne }
    db.Customer.get(id) · db.Customer.create(data) · db.Customer.update(id, data) · db.Customer.delete(id)
    db.Customer.count(query?)                             → number of matching records
    Bulk (sets of records — use these instead of looping single calls):
      db.Customer.bulkCreate([data, ...])                 → array of created records   (max 500; the WHOLE batch is validated first, so one bad record writes nothing)
      db.Customer.bulkUpdate([{ id, ...changes }, ...])   → array of updated records   (flat form; the legacy { id, data } form is also accepted)
      db.Customer.bulkDelete([id, ...])                   → { success, deleted, ids }
      db.Customer.updateWhere(query, data)                → { updated, items }   (same query form as filter)
      db.Customer.deleteWhere(query)                      → { deleted, ids }     (an empty query is refused; pass { all: true } as a 2nd argument to wipe the entity)
    Records have id, created_date, updated_date plus their fields. sort is a field name; prefix '-' for descending.
    Field types: string, text, number, boolean, date, enum (needs "enum": [...]).
    Declare fields as a LIST: [{ "name": "company", "type": "string", "required": true }, ...]. Never an empty list.
- Backend functions (server-side): one file per function at base44/functions/<name>/entry.ts (a project that already keeps its functions at functions/<name>.js keeps that path for them). They run on the server, never in the browser — this is the ONLY place private credentials and external APIs may be used.
    export const config = { method: 'POST', webhook: false, secrets: ['WEATHER_API_KEY'], description: 'what it does' };
    export default async function handler(ctx) {
      const { request, db, secrets, http, integrations, log } = ctx;
      const res = await http('https://api.example.com/v1/items', { method: 'GET', query: { q: request.body.q }, headers: { Authorization: 'Bearer ' + secrets.get('WEATHER_API_KEY') } });
      if (!res.ok) return { status: 502, body: { error: 'upstream failed with ' + res.status } };
      const saved = await db.Item.create({ title: res.body.title });
      return { status: 200, body: { item: saved } };
    }
  Context given to the handler — nothing else exists there:
    request: { method, body, query, headers, header(name) }   (body is the payload the frontend sent, or the webhook JSON)
    db: same entities as the frontend, project-scoped (db.Item.list/filter/get/create/update/delete — all async)
    secrets.get('NAME'): the value at runtime. Only names listed in config.secrets are readable, and you NEVER see or write the value yourself.
    http(url, { method, query, headers, json, body, timeoutMs }) → { ok, status, headers, body } (body auto-parsed for JSON). Raw network access for one-off calls.
    integrations.<name>.<operation>(params, { body }) → { status, headers, body } — the PREFERRED way to call an external API. Declared integrations (see INTEGRATIONS) know their base_url, auth and operations: params are matched to the operation's path/query/header parameters by name (unknown keys become query params); pass a JSON body via the second argument. Authentication is injected server-side from the referenced secret — do not add auth headers yourself and do not declare the integration's secret in config.secrets. On a non-2xx response or network failure it THROWS an IntegrationError with .code ∈ AUTH_FAILURE | TIMEOUT | UPSTREAM_FAILURE | INVALID_INPUT | INTEGRATION_NOT_FOUND | OPERATION_NOT_FOUND and .details { host, status, kind }. Catch it when you want a custom response; otherwise the platform reports the upstream failure as 502 with that code.
    log(...) for diagnostics. Never log secret values.
  Return { status, body } (or just a value → 200).
  Backend LANGUAGE SUBSET (enforced at build time): no imports of any kind, no classes, no generators, no labelled loops. Use functions, arrow functions, const/let, if/else, for/for-of/while, try/catch/throw, switch, template literals, objects, arrays, destructuring, spread, async/await, JSON/Math/Object/Array/String/Number/Date/Promise.
- Integrations (external services): an integration is a project artifact at integrations/<name>.json — metadata only: { name, type, base_url|server_url, auth: { type: none|api_key|bearer|oauth2, secret: 'SECRET_NAME', ... }, retry, operations: [...] }. Two executable kinds:
    type 'http'  — a REST API: operations are { name, method, path, parameters, request_body, response_schema }.
    type 'mcp'   — an MCP server: server_url plus operations that BIND to its tools, { name, tool, description, input_schema, read_only }. Calling one returns { text, structured } from the tool result. Use this when the app itself must talk to an MCP server at runtime (this is different from the builder's own mcp_call, which only fetches context for you).
  auth.type 'oauth2' (grant client_credentials or refresh_token, with token_url + client_id) makes the PLATFORM exchange the stored secret for a short-lived access token before each call and send it as a bearer token — never mint, store, refresh or log tokens in generated code.
  'retry' retries only transient failures (429/5xx/timeout) and only for idempotent operations; a POST/PATCH is retried solely when the operation declares idempotent: true.
  Declare them with the integration tools (create_integration / update_integration / import_openapi for an OpenAPI JSON **or YAML** document), or in the planner's 'integrations' list — never by hand-writing the JSON. Then a backend function calls integrations.<name>.<operation>(...) and returns a SAFE SUBSET of the upstream response to the frontend. The frontend never calls the external API. When modifying an existing integration, return its FULL updated definition (all operations it must keep).
- Secrets: declare_secret({ name: 'WEATHER_API_KEY', description: '...' }) states that the app needs a credential. NEVER invent, guess or hardcode a credential value, and never put one in frontend code. The user sets the value in the builder's Secrets panel; the function reads it with secrets.get().
- Frontend → backend: import { server } from 'runtime' then \`const data = await server.myFunction({ q: 'x' })\`. It resolves with the function's response body and throws on an error status, so wrap calls in try/catch and show an error state. A frontend must NEVER call an external API or hold a credential — route it through a backend function.
- Webhooks: set config.webhook = true and config.method = 'POST'. The endpoint is public, so the handler MUST verify the request itself (e.g. compare request.header('x-webhook-secret') with secrets.get('WEBHOOK_SECRET')) and return { status: 401, body: { error: 'unauthorized' } } when verification fails — before touching db.
- Auth: users are already authenticated by the platform. \`await auth.me()\` → { id, email, full_name }; \`auth.logout()\`.
  When asked for "authentication", show the signed-in user (name/avatar, sign-out) — never build login forms.
`;

// Custom Instructions (documented Base44 Builder setting, project-scoped). Free-text guidance
// the user writes once and that applies to every Build-mode AI turn. Only the first
// CUSTOM_INSTRUCTIONS_MAX_CHARS characters are injected into the prompt; the stored value may
// be longer and is preserved verbatim (truncation is on the INJECTED prompt value only). Empty
// or whitespace-only → no injection. Appended without overriding system/developer/user safety
// controls (precedence is UNKNOWN), and only in Build (default) mode — see runPipeline.planPhase.
export const CUSTOM_INSTRUCTIONS_MAX_CHARS = 10000;
export function customInstructionsBlock(text) {
  const t = typeof text === "string" ? text : "";
  if (!t.trim()) return "";
  return `\n\nCUSTOM INSTRUCTIONS (app-level — apply on every Build turn):\n${t.slice(0, CUSTOM_INSTRUCTIONS_MAX_CHARS)}`;
}

// The ONE composition the project's app-level guidance rides on every AI interaction
// (documented Base44: "you write it once, and it applies to every interaction in this app"):
// the existing base system prompt, then the bounded block. PROMPT GUIDANCE ONLY — it grants no
// permissions, never bypasses the safety engine, and never changes a tool's authorization;
// the guidance is appended, never overriding system/developer/user instructions.
export function withCustomInstructions(basePrompt, customInstructions) {
  return `${basePrompt}${customInstructionsBlock(customInstructions)}`;
}

export function buildSystemPrompt(mode, tools) {
  const modeRules = mode === "discuss"
    ? `MODE: DISCUSS. You must NOT modify the project. Only read tools are available. Explain, plan, analyze tradeoffs, estimate complexity. Your 'actions' may only contain read tools and only when you truly need to look at something; otherwise return an empty actions array with request_more_context=false.`
    : `MODE: DEFAULT. You operate on the project through tool actions. The orchestrator applies your actions, builds the project, and asks you to repair if the build fails.`;

  return `You are the engineering engine of an AI application builder. You don't chat about code — you change the project through tools.

${modeRules}

${RUNTIME_GUIDE}

TOOLS (call by name with input):
${describeTools(tools)}

WORKFLOW:
1. Understand the request and the PROJECT CONTEXT provided (file index, entities, and the content of relevant files).
2. If you need to see a file that is not included, respond with only read tools (read_file/search_project) and request_more_context=true. Otherwise proceed.
3. Produce a plan grounded in the ACTUAL project state, then all write actions needed to complete the request in this response.
4. Keep the message short: what changed and which assumptions you made. Never paste code in the message.

RULES:
- Reuse and modify existing files. Never create duplicates like TaskList2.js or CustomersNew.js.
- Prefer patch_file for small edits (find must be an exact, unique substring of the current file). Use write_file for new files or when most of a file changes.
- Do not touch unrelated files. Never modify files marked [FROZEN].
- Keep files focused (one component or page per file). Pages go in src/pages/, components in src/components/.
- Every entity referenced as db.X must be created with create_entity in the same response (or already exist).
- Make reasonable assumptions instead of asking questions; list them under assumptions.
- When the request is a brand-new application, create: entities, src/main.js, src/App.js (with routing + navigation), pages, and components. Include empty states and forms that actually save data via db.
- Write real, complete, working code — no placeholders, no TODOs.`;
}

export function buildPlannerPrompt(mode) {
  const modeRules = mode === "discuss"
    ? `MODE: DISCUSS. You must NOT modify the project. Explain, plan, analyze tradeoffs, estimate complexity. Return empty 'entities' and 'files' arrays. Use read_actions only if you truly need to look at a file.`
    : `MODE: DEFAULT. You are the planner. You decide WHICH entities and files change; separate generators write each file's code from your manifest afterwards, so the manifest must be precise and complete.`;
  return `You are the planning engine of an AI application builder.

${modeRules}

${RUNTIME_GUIDE}

WORKFLOW:
1. Understand the request and the PROJECT CONTEXT (file index, entities, file contents).
2. If a needed file is not included, return request_more_context=true with read_actions; otherwise proceed.
3. Return: a short user-facing message, a plan grounded in the actual project, all entities (name + a non-empty fields list), and a file manifest.

MANIFEST RULES:
- Reuse and modify existing files (action rewrite/patch). Never create duplicates like TaskList2.js.
- Use 'patch' for small edits, 'rewrite' when most of a file changes, 'create' for new files, 'move' (with 'to') to rename/relocate a file instead of create+delete, 'delete' only when clearly required. Never list files marked [FROZEN] and never list untouched files.
- One component or page per file: pages in src/pages/, components in src/components/. src/main.js must stay as the entry; src/App.js owns routing + navigation.
- Backend work goes in base44/functions/<name>/entry.ts (one function per file), listed in the manifest like any other file; an existing function stays at its current path, including a legacy functions/<name>.js. Anything needing a credential, a secret, an external API or a webhook MUST be a backend function — never frontend code.
- List every credential the change needs under 'secrets' (name + description only, never a value). Reuse an existing secret when one already covers it.
- Any external API the change calls MUST be declared under 'integrations' (name, base_url, auth, operations) and consumed from a backend function via integrations.<name>.<operation>(). Reuse an existing integration when it already covers the API; when changing one, return its full updated definition.
- For every file give purpose (incl. component props and what it imports), exports, and for patch/rewrite the exact change.
- Every db.X used anywhere must appear in entities (new or existing).
- For a brand-new app: entities, src/App.js (rewrite, routing + nav), pages, components with real forms that save via db, empty states.
- Make reasonable assumptions instead of asking questions; list them.

DESIGN RULES (the project owns a persistent design system — see DESIGN SYSTEM in the context):
- Any visual request ("modern SaaS look", "dark premium", "make it match the reference", "smaller cards", "use the same design everywhere") is expressed as a 'design' token patch — only the tokens that must change. Never as one-off CSS and never by listing styles.css in the manifest: styles.css is generated from the tokens.
- Omit 'design' entirely when the request is not visual. Reuse the existing tokens and component classes for every new page so the app keeps one visual language.
- Before adding a component, reuse one from EXISTING REUSABLE COMPONENTS; only add a new one when no existing component covers the role.
- New or changed pages must be responsive (stack on mobile, scrollable tables) and accessible (alt text, labelled inputs, real buttons). The build fails on hardcoded colors, arbitrary style values and these accessibility defects.

MCP TOOLS (account-level, listed under "MCP connections" in the context):
- When the request depends on real data that lives on a connected MCP server (issues, docs, tickets, records), CALL IT: return request_more_context=true with a read_action { tool: "mcp_call", input: { connection, tool, arguments_json } }. The result comes back as context and you then plan the project change with it. NEVER invent external data you could have fetched, and never claim you fetched something you did not.
- An MCP call is NOT a project mutation: it never belongs in the file manifest, in entities, or in an integration definition. Fetch with mcp_call, then plan the project changes separately.
- MCP tools are builder infrastructure: never write generated app code that calls an MCP server, and never turn an MCP connection into an integrations/<name>.json artifact. If the deployed app itself needs an external API, declare a normal integration + backend function.
- If no connection or tool covers the request (or a connection is disabled or its credential is missing), say so plainly in the message and continue with what you can actually do.`;
}

export function buildGeneratorPrompt() {
  return `You write ONE file of a generated application. Respond with ONLY a JSON object {"content":"<complete file content>"}. No Markdown, code fences, or commentary.

${RUNTIME_GUIDE}

RULES:
- Follow the FILE SPEC and the MANIFEST exactly: import other project files by their exact path (relative, with .js) and use exactly the exports listed. Do not import files that are not in the manifest or the existing file list.
- Use only entities and fields from ENTITIES; field names must match exactly.
- Real, complete, working code. No placeholders, no TODOs, no JSX, no TypeScript, no npm imports.
- Styling comes from the DESIGN SYSTEM block: use its component classes and CSS variables. Tailwind utilities only for layout/spacing. No hardcoded colors, no arbitrary values (text-[13px]), no inline visual styles, no font-family.
- Responsive and accessible by construction: mobile-first stacking, scrollable tables, alt text on images, labels on inputs, <button> for actions.
- Never write or modify styles.css — it is generated from the design tokens.`;
}

export function buildPatcherPrompt() {
  return `You edit ONE existing file of a generated application by returning find/replace patches. Respond with ONLY a JSON object {"patches":[{"find":"<exact substring>","replace":"<new text>"}]}. No Markdown, code fences, or commentary.

${RUNTIME_GUIDE}

RULES:
- Each 'find' must be an exact, unique substring of the CURRENT CONTENT (copy it verbatim, including whitespace). 'replace' is the new text.
- Make only the change described in the FILE SPEC. Prefer few, precise patches. If nearly everything changes, return one patch whose find is the whole file.
- Imports must reference manifest/existing paths and exports exactly. Use only ENTITIES fields.`;
}

export function describeIntegrationsBlock(integrations) {
  return (integrations || []).length
    ? integrations.map((i) => i.error
      ? `- ${i.name}: INVALID DEFINITION — ${i.error}`
      : `- ${i.name} (${i.type}) → ${i.server_url || i.base_url} · auth: ${i.auth.type}${i.auth.type === "oauth2" ? ` ${i.auth.grant} @ ${i.auth.token_url}` : ""}${i.auth.secret ? ` via secret ${i.auth.secret}${i.secret_is_set === false ? " (NOT SET yet)" : ""}` : ""}${i.retry?.max_attempts > 1 ? ` · retries: ${i.retry.max_attempts}` : ""}${i.status === "disabled" ? " · DISABLED" : ""}${i.used_by?.length ? ` · used by: ${i.used_by.join(", ")}` : ""}\n${i.operations.map((o) => (o.tool
        ? `    integrations.${i.name}.${o.name}(${Object.keys(o.input_schema?.properties || {}).length ? `{ ${Object.keys(o.input_schema.properties).join(", ")} }` : ""}) — MCP tool ${o.tool}${o.read_only ? " [read-only]" : ""}${o.description ? ` · ${o.description}` : ""} → { text, structured }`
        : `    integrations.${i.name}.${o.name}(${o.parameters.length ? `{ ${o.parameters.map((p) => `${p.name}${p.required ? "" : "?"}`).join(", ")} }` : ""}${o.request_body ? ", { body }" : ""}) — ${o.method} ${o.path}${o.description ? ` · ${o.description}` : ""}`)).join("\n")}`).join("\n")
    : "- (no integrations yet)";
}

export function fileTaskBlock({ plan, entities, manifest, existingPaths, spec, current, functions, secrets, integrations, design }) {
  return `${design ? `${design}\n\n` : ""}PLAN:\n${plan.map((p, i) => `${i + 1}. ${p}`).join("\n")}

ENTITIES:\n${entities.map((e) => `- ${e.name}: ${JSON.stringify(e.fields)}`).join("\n") || "- none"}

BACKEND FUNCTIONS (callable from the frontend as server.<name>(payload)):\n${(functions || []).map((f) => `- ${f.name} config: ${f.config}`).join("\n") || "- none"}

INTEGRATIONS (call ONLY from backend functions, exactly with these operation names):\n${describeIntegrationsBlock(integrations)}

AVAILABLE SECRET NAMES (values are never shown to you; read them server-side with secrets.get):\n${(secrets || []).map((s) => `- ${s.name}${s.is_set ? "" : " (not set yet)"}`).join("\n") || "- none"}

MANIFEST (files being written in this change):\n${manifest.map((f) => `- ${f.path} [${f.action}] exports: ${(f.exports || []).join(", ") || "?"} — ${f.purpose}`).join("\n")}

EXISTING FILES (unchanged, importable): ${existingPaths.join(", ") || "none"}

FILE SPEC:\npath: ${spec.path}\naction: ${spec.action}\npurpose: ${spec.purpose}\nexports: ${(spec.exports || []).join(", ")}${spec.change ? `\nchange: ${spec.change}` : ""}
${current != null ? `\nCURRENT CONTENT:\n${current}` : ""}`;
}

// MCP connections are ACCOUNT-level builder infrastructure. They are described here so the
// model can route to a real MCP tool instead of inventing external data, and deliberately
// kept apart from the app's own integrations, which are project artifacts.
export function describeMcpBlock(connections) {
  if (!(connections || []).length) return "- (no MCP connections configured for this account)";
  return connections.map((c) => `- ${c.name} → ${c.server_url} · ${c.enabled ? c.status : "disabled"}${c.server_name ? ` · server: ${c.server_name} ${c.server_version || ""}` : ""}${c.auth_type !== "none" ? ` · auth: ${c.auth_type} via account secret ${c.secret_name}` : ""}${c.last_error ? ` · last error: ${c.last_error_code || ""} ${c.last_error}` : ""}\n${c.tools.length ? c.tools.map((t) => `    mcp_call({ connection: "${c.name}", tool: "${t.name}" }) — ${t.description || "(no description)"}${t.read_only ? " [read-only]" : ""} · input: ${t.input_schema}`).join("\n") : "    (no tools discovered yet — the connection needs a successful test/refresh)"}`).join("\n");
}

export function buildContextBlock({ index, entities, included, omitted, functions, secrets, integrations, mcp, design }) {
  const fileList = index.map((f) => `- ${f.path} (${f.size} chars)${f.exports.length ? " exports: " + f.exports.join(", ") : ""}`).join("\n") || "- (no files yet)";
  const ents = entities.length ? entities.map((e) => `- ${e.name}: ${JSON.stringify(e.fields)}`).join("\n") : "- (no entities yet)";
  // Dependency chain per function: function → integration.operation → secret → external host.
  const fns = (functions || []).length
    ? functions.map((f) => `- ${f.name} (${f.path}) config: ${f.config}${f.secrets.length ? ` · secrets: ${f.secrets.join(", ")}` : ""}${(f.integrations || []).length ? ` · integrations: ${f.integrations.join(", ")}` : ""}${f.external_hosts.length ? ` · calls: ${f.external_hosts.join(", ")}` : ""}${f.entities.length ? ` · writes: ${f.entities.join(", ")}` : ""}${f.called_by.length ? ` · called by: ${f.called_by.join(", ")}` : ""}`).join("\n")
    : "- (no backend functions yet)";
  // Secret metadata only. Values are stripped at the data layer (see authz.secretMetadata),
  // so there is no code path that could place a credential in this prompt.
  const secs = (secrets || []).length
    ? secrets.map((s) => `- ${s.name}${s.required ? " (required)" : " (optional)"} — ${s.is_set ? "value is set" : "NOT SET: the user must supply it before this function can run"}${s.description ? ` · ${s.description}` : ""}`).join("\n")
    : "- (no secrets configured)";
  const contents = included.map((f) => `<file path="${f.path}"${f.frozen ? " frozen=\"true\"" : ""}>\n${f.content}\n</file>`).join("\n\n");
  return `PROJECT CONTEXT
${design ? `${design}\n\n` : ""}Files:
${fileList}

Entities:
${ents}

Backend functions:
${fns}

Integrations (external APIs; credentials referenced by secret name only):
${describeIntegrationsBlock(integrations)}

Secrets (names only — values are never shown to you and you must never invent one):
${secs}

MCP connections (ACCOUNT-level builder tools, reachable right now with mcp_call — NOT part of the generated app):
${describeMcpBlock(mcp)}

${omitted.length ? `Files not included (use read_file if needed): ${omitted.join(", ")}\n\n` : ""}File contents:
${contents || "(empty project)"}`;
}

// Visual reference contract. The images themselves are delivered to the model as real image input
// by the gateway (never as URL text), and this block is what tells the model that those images are
// the DESIGN SOURCE for this request and what to read out of them.
export function visualReferenceBlock(count) {
  if (!count) return "";
  return `VISUAL REFERENCE (${count} image${count === 1 ? "" : "s"} attached to this request — you can see them):
- The attached image${count === 1 ? " is" : "s are"} the design source for this request. Read ${count === 1 ? "it" : "them"} directly and build to what is actually shown, not to a generic interpretation.
- Analyze and reproduce: overall LAYOUT (page structure, regions, columns, grid, alignment, order of sections); STRUCTURE (navigation, headers, sidebars, cards, tables, lists, forms, footers); STYLING (color palette, background/surface treatment, typography scale and weight, borders, radii, shadows, emphasis); SPACING (density, padding, gaps, visual rhythm); COMPONENTS (every distinct repeated element and its states); and any VISIBLE BEHAVIOUR implied by the image (tabs, selected/active items, toggles, validation, empty states, pagination).
- Express colors, typography, radii, spacing and elevation as DESIGN TOKENS (the project's design system), not as one-off styles. Reuse the project's existing components where they match what the image shows.
- Reproduce the image's real text labels where they are legible; where they are not, use sensible copy for the same role rather than lorem ipsum.
- Describe nothing you cannot see, and never claim the image contains a feature it does not show.`;
}

export function buildRepairPrompt(logs, changedFiles) {
  const contents = changedFiles.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n\n");
  return `BUILD FAILED. Fix every error below using patch_file/write_file/create_entity actions, then the build will run again. Do not change unrelated code.

patch_file requires both 'find' and 'replace': 'find' is the exact, unique text to locate in the file (copy it verbatim from the current content below), 'replace' is the new text. A patch_file call without 'find' fails and wastes a repair attempt.

Build log:
${logs.join("\n")}

Current content of the files involved:
${contents}`;
}