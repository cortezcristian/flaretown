// MCP servers and their attachment to agents (task 018, SPEC-mcps 4). The only place MCP rules
// live. Servers store header templates with ${SECRET} references; values are resolved here, in
// the Worker, right before they go to the agent's Durable Object (never to a page or a tool).

import { agentStub } from "../runtime";
import { type Caller, isPrincipal } from "./caller";
import { ServiceError } from "./errors";
import { putSecret, redact, referencedSecrets, resolveTemplates } from "./secrets";

export type Transport = "auto" | "streamable-http" | "sse";
export type AuthKind = "none" | "headers" | "oauth";
export type Policy = "allowed" | "ask" | "off";
export type AttachStatus = "ready" | "connecting" | "authenticating" | "failed" | "pending";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  transport: Transport;
  auth: AuthKind;
  headers: Record<string, string>; // templates only
  policy: Policy;
  description: string;
  builtin: boolean;
  created_at: string;
  updated_at: string;
  secrets: string[]; // referenced secret names
  missing_secrets: string[];
  agents: AgentMcp[];
}

export interface AgentMcp {
  agent_id: string;
  agent_name: string;
  server_id: string;
  status: AttachStatus;
  auth_url: string | null;
  error: string | null;
  attached_by: string;
  attached_at: string;
  updated_at: string;
}

export interface McpTool {
  server_id: string;
  name: string;
  key: string; // the AI tool name the agent sees
  description: string;
  read_only: boolean;
}

// What the agent's Durable Object needs to connect (secrets already resolved).
export interface AttachRequest {
  id: string;
  name: string;
  url: string;
  transport: Transport;
  headers: Record<string, string>;
  callbackHost?: string;
  callbackPath: string;
}

export interface AttachResult {
  state: string;
  auth_url: string | null;
  error: string | null;
}

export interface LiveMcpStatus {
  servers: Array<{ id: string; name: string; state: string; error: string | null; auth_url: string | null }>;
  tools: McpTool[];
}

const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const TRANSPORTS: Transport[] = ["auto", "streamable-http", "sse"];
const AUTHS: AuthKind[] = ["none", "headers", "oauth"];
const POLICIES: Policy[] = ["allowed", "ask", "off"];
// Headers that carry credentials must point at a secret, so no value is ever stored in clear.
const SENSITIVE_HEADER = /authorization|cookie|token|key|secret|password|auth/i;

const now = () => new Date().toISOString();

// The AI SDK tool name the Agents SDK gives an MCP tool.
export function toolKey(serverId: string, toolName: string): string {
  return `tool_${serverId.replace(/-/g, "")}_${toolName}`;
}

export function callbackPath(agentId: string, serverId: string): string {
  return `mcp/oauth/callback/${agentId}/${serverId}`;
}

type ServerRow = Omit<McpServer, "headers" | "builtin" | "secrets" | "missing_secrets" | "agents"> & { headers: string; builtin: number };

async function secretNames(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT name FROM secrets").all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

function toServer(r: ServerRow, known: Set<string>, agents: AgentMcp[]): McpServer {
  const headers = JSON.parse(r.headers || "{}") as Record<string, string>;
  const secrets = referencedSecrets(headers);
  return {
    ...r,
    headers,
    builtin: r.builtin === 1,
    secrets,
    missing_secrets: secrets.filter((s) => !known.has(s)),
    agents: agents.filter((a) => a.server_id === r.id),
  };
}

const ATTACH_SELECT = `SELECT m.*, COALESCE(a.name, m.agent_id) AS agent_name FROM agent_mcps m LEFT JOIN agents a ON a.id = m.agent_id`;

export async function listServers(db: D1Database): Promise<McpServer[]> {
  const [{ results: rows }, { results: attached }, known] = await Promise.all([
    db.prepare("SELECT * FROM mcp_servers ORDER BY builtin DESC, name").all<ServerRow>(),
    db.prepare(`${ATTACH_SELECT} ORDER BY m.attached_at`).all<AgentMcp>(),
    secretNames(db),
  ]);
  return rows.map((r) => toServer(r, known, attached));
}

export async function getServer(db: D1Database, id: string): Promise<McpServer> {
  const row = await db.prepare("SELECT * FROM mcp_servers WHERE id = ?").bind(id).first<ServerRow>();
  if (!row) throw new ServiceError("not_found", `MCP server ${id} not found`, "See the MCPs section for the server ids.", 404);
  const { results } = await db.prepare(`${ATTACH_SELECT} WHERE m.server_id = ? ORDER BY m.attached_at`).bind(id).all<AgentMcp>();
  return toServer(row, await secretNames(db), results);
}

function requireHuman(caller: Caller, what: string) {
  if (caller.kind !== "human") throw new ServiceError("forbidden", `Not allowed: only the human ${what}`, "", 403);
}

// ---- validation ------------------------------------------------------------------------------

export interface ServerInput {
  id?: string;
  name?: string;
  url?: string;
  transport?: string;
  auth?: string;
  headers?: Record<string, unknown>;
  policy?: string;
  description?: string;
}

function cleanUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ServiceError("invalid_input", "URL is not valid", "Use the server's https:// endpoint, e.g. https://mcp.example.com/mcp.");
  }
  if (url.protocol !== "https:") throw new ServiceError("invalid_input", "URL must use https", "Remote MCP servers only (Streamable HTTP or SSE).");
  return url.href;
}

// Normalize ${env:NAME} and ${input:name} to ${NAME}.
export function normalizeTemplate(value: string): string {
  return value.replace(/\$\{(?:env:|input:)?([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_m, n: string) => `\${${n.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}}`);
}

function cleanHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!HEADER_RE.test(name)) throw new ServiceError("invalid_input", `Invalid header name "${name}"`, "Letters, digits and dashes.");
    if (typeof value !== "string" || !value.trim()) throw new ServiceError("invalid_input", `Header ${name} has no value`, "");
    const template = normalizeTemplate(value.trim());
    if (SENSITIVE_HEADER.test(name) && referencedSecrets({ [name]: template }).length === 0) {
      throw new ServiceError(
        "invalid_input",
        `Header ${name} must use a secret`,
        `Add the value under Secrets and write it as a reference, e.g. "Bearer \${GITHUB_TOKEN}". Credentials are never stored in clear.`,
      );
    }
    out[name] = template;
  }
  return out;
}

function pick<T extends string>(value: string | undefined, allowed: T[], field: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw new ServiceError("invalid_input", `Unknown ${field} "${value}"`, `Use ${allowed.join(", ")}.`);
  return value as T;
}

export async function createServer(db: D1Database, caller: Caller, input: ServerInput): Promise<McpServer> {
  requireHuman(caller, "adds MCP servers");
  const id = (input.id ?? "").trim();
  if (!ID_RE.test(id)) throw new ServiceError("invalid_input", "Invalid id", "Lowercase letters, digits and dashes, starting with a letter (max 48), e.g. github.");
  const name = (input.name ?? "").trim() || id;
  if (!input.url) throw new ServiceError("invalid_input", "URL is required", "");
  const url = cleanUrl(input.url);
  const headers = cleanHeaders(input.headers);
  const auth = pick(input.auth, AUTHS, "auth", Object.keys(headers).length ? "headers" : "none");
  const transport = pick(input.transport, TRANSPORTS, "transport", "auto");
  const policy = pick(input.policy, POLICIES, "policy", "allowed");
  const exists = await db.prepare("SELECT id FROM mcp_servers WHERE id = ?").bind(id).first();
  if (exists) throw new ServiceError("conflict", `A server with id ${id} already exists`, "Pick another id or edit that one.", 409);
  const ts = now();
  await db
    .prepare(
      `INSERT INTO mcp_servers (id, name, url, transport, auth, headers, policy, description, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, name, url, transport, auth, JSON.stringify(headers), policy, (input.description ?? "").trim(), ts, ts)
    .run();
  return getServer(db, id);
}

// Builtin servers: only policy (and description) can change; their URL and auth are Cloudflare's.
export async function updateServer(db: D1Database, caller: Caller, id: string, input: ServerInput): Promise<McpServer> {
  requireHuman(caller, "edits MCP servers");
  const current = await getServer(db, id);
  const builtin = current.builtin;
  if (builtin && (input.url !== undefined || input.auth !== undefined || input.headers !== undefined || input.transport !== undefined)) {
    throw new ServiceError("invalid_input", "Cloudflare servers can't be edited", "Only the policy can change. Add a custom server for anything else.");
  }
  const headers = input.headers !== undefined ? cleanHeaders(input.headers) : current.headers;
  const next = {
    name: (input.name ?? current.name).trim() || current.name,
    url: input.url !== undefined ? cleanUrl(input.url) : current.url,
    transport: pick(input.transport, TRANSPORTS, "transport", current.transport),
    auth: pick(input.auth, AUTHS, "auth", current.auth),
    policy: pick(input.policy, POLICIES, "policy", current.policy),
    description: (input.description ?? current.description).trim(),
  };
  await db
    .prepare("UPDATE mcp_servers SET name = ?, url = ?, transport = ?, auth = ?, headers = ?, policy = ?, description = ?, updated_at = ? WHERE id = ?")
    .bind(next.name, next.url, next.transport, next.auth, JSON.stringify(headers), next.policy, next.description, now(), id)
    .run();
  return getServer(db, id);
}

export async function deleteServer(env: Env, caller: Caller, id: string): Promise<void> {
  requireHuman(caller, "deletes MCP servers");
  const server = await getServer(env.DB_CORE, id);
  if (server.builtin) throw new ServiceError("invalid_input", "Cloudflare servers can't be deleted", "Set its policy to off instead.");
  for (const a of server.agents) await detachServer(env, caller, a.agent_id, id);
  await env.DB_CORE.prepare("DELETE FROM mcp_servers WHERE id = ?").bind(id).run();
}

// ---- permissions -----------------------------------------------------------------------------

async function requireCanManage(db: D1Database, caller: Caller, agentId: string) {
  const agent = await db.prepare("SELECT id, tier, parent_id, status FROM agents WHERE id = ?").bind(agentId).first<{
    id: string;
    tier: string;
    parent_id: string | null;
    status: string;
  }>();
  if (!agent) throw new ServiceError("not_found", `Agent ${agentId} not found`, "Check the agent id (agents_list).", 404);
  if (agent.status !== "active") throw new ServiceError("invalid_state", `${agentId} is retired`, "", 409);
  if (caller.kind === "human" || isPrincipal(caller)) return;
  const isLeadOfIt = caller.kind === "agent" && agent.tier === "operator" && agent.parent_id === caller.id;
  if (!isLeadOfIt) throw new ServiceError("forbidden", "Not allowed: only the human, the Principal or its Lead can change an agent's MCP servers", "", 403);
}

// ---- attach / detach -------------------------------------------------------------------------

function mapState(state: string): AttachStatus {
  if (state === "ready") return "ready";
  if (state === "authenticating") return "authenticating";
  if (state === "failed") return "failed";
  if (state === "connecting" || state === "connected" || state === "discovering") return "connecting";
  return "pending";
}

async function saveStatus(db: D1Database, agentId: string, serverId: string, status: AttachStatus, authUrl: string | null, error: string | null) {
  await db
    .prepare("UPDATE agent_mcps SET status = ?, auth_url = ?, error = ?, updated_at = ? WHERE agent_id = ? AND server_id = ?")
    .bind(status, authUrl, error, now(), agentId, serverId)
    .run();
}

export interface AttachOptions {
  origin?: string; // the UI's origin, for the OAuth callback (human attaches only)
}

export async function attachServer(env: Env, caller: Caller, agentId: string, serverId: string, opts: AttachOptions = {}): Promise<AgentMcp> {
  const db = env.DB_CORE;
  await requireCanManage(db, caller, agentId);
  const server = await getServer(db, serverId);
  if (server.policy === "off") throw new ServiceError("invalid_state", `${server.name} is off`, "Turn its policy on in the MCPs section first.", 409);
  if (caller.kind !== "human") {
    if (server.policy !== "allowed") {
      throw new ServiceError("forbidden", `Not allowed: ${server.name} needs approval (policy ask)`, "Ask the human to attach it, or request it with decisions_request.", 403);
    }
    if (server.auth === "oauth") {
      throw new ServiceError("forbidden", `Not allowed: ${server.name} uses OAuth`, "The human connects OAuth servers from the MCPs section (they sign in).", 403);
    }
  }
  if (server.auth === "oauth" && !opts.origin) {
    throw new ServiceError("invalid_input", "OAuth needs the app's address", "Connect it from the MCPs section or the chat MCPs panel.");
  }
  // Fails with secret_missing (and the names) before anything is attached.
  const headers = Object.keys(server.headers).length ? await resolveTemplates(env, server.headers) : {};
  const ts = now();
  const by = caller.kind === "agent" ? caller.id : caller.kind === "human" ? "human" : "orchestrator";
  await db
    .prepare(
      `INSERT INTO agent_mcps (agent_id, server_id, status, attached_by, attached_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?)
       ON CONFLICT (agent_id, server_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at`,
    )
    .bind(agentId, serverId, by, ts, ts)
    .run();
  let result: AttachResult;
  try {
    const stub = await agentStub(env, agentId);
    result = await stub.mcpAttach({
      id: server.id,
      name: server.name,
      url: server.url,
      transport: server.transport,
      headers,
      callbackHost: opts.origin,
      callbackPath: callbackPath(agentId, server.id),
    });
  } catch (err) {
    result = { state: "failed", auth_url: null, error: err instanceof Error ? err.message : String(err) };
  }
  const error = result.error ? (await redact(env, result.error)).slice(0, 1000) : null;
  await saveStatus(db, agentId, serverId, mapState(result.state), result.auth_url, error);
  return (await agentMcps(db, agentId)).find((a) => a.server_id === serverId)!;
}

export async function detachServer(env: Env, caller: Caller, agentId: string, serverId: string): Promise<{ ok: true }> {
  const db = env.DB_CORE;
  const row = await db.prepare("SELECT agent_id FROM agent_mcps WHERE agent_id = ? AND server_id = ?").bind(agentId, serverId).first();
  if (!row) throw new ServiceError("not_found", `${serverId} is not attached to ${agentId}`, "", 404);
  const agent = await db.prepare("SELECT status FROM agents WHERE id = ?").bind(agentId).first<{ status: string }>();
  if (agent?.status === "active") {
    await requireCanManage(db, caller, agentId);
    try {
      await (await agentStub(env, agentId)).mcpDetach(serverId);
    } catch (err) {
      console.error(`mcp detach ${serverId} from ${agentId} failed`, err);
    }
  } else if (caller.kind !== "human") {
    throw new ServiceError("forbidden", "Not allowed", "", 403);
  }
  await db.prepare("DELETE FROM agent_mcps WHERE agent_id = ? AND server_id = ?").bind(agentId, serverId).run();
  return { ok: true };
}

// Reconnect every agent using a server (after its secrets or settings change). Human only.
export async function reconnectServer(env: Env, caller: Caller, serverId: string, opts: AttachOptions = {}): Promise<AgentMcp[]> {
  requireHuman(caller, "reconnects MCP servers");
  const server = await getServer(env.DB_CORE, serverId);
  const out: AgentMcp[] = [];
  for (const a of server.agents) out.push(await attachServer(env, caller, a.agent_id, serverId, opts));
  return out;
}

// Servers that reference a secret, for "Reconnect" after rotating it.
export async function serversUsingSecret(db: D1Database, name: string): Promise<string[]> {
  return (await listServers(db)).filter((s) => s.secrets.includes(name)).map((s) => s.id);
}

export async function agentMcps(db: D1Database, agentId: string): Promise<AgentMcp[]> {
  const { results } = await db.prepare(`${ATTACH_SELECT} WHERE m.agent_id = ? ORDER BY m.attached_at`).bind(agentId).all<AgentMcp>();
  return results;
}

export interface AgentMcpView extends AgentMcp {
  name: string;
  url: string;
  auth: AuthKind;
  policy: Policy;
  description: string;
  tools: McpTool[];
}

// An agent's servers with live status from its Durable Object (D1 keeps the last known one).
export async function agentMcpStatus(env: Env, agentId: string): Promise<{ servers: AgentMcpView[] }> {
  const db = env.DB_CORE;
  const rows = await agentMcps(db, agentId);
  if (!rows.length) return { servers: [] };
  let live: LiveMcpStatus = { servers: [], tools: [] };
  try {
    live = await (await agentStub(env, agentId)).mcpStatus();
  } catch (err) {
    console.error(`mcp status of ${agentId} failed`, err);
  }
  const all = await listServers(db);
  const out: AgentMcpView[] = [];
  for (const row of rows) {
    const server = all.find((s) => s.id === row.server_id);
    const l = live.servers.find((s) => s.id === row.server_id);
    let view: AgentMcp = row;
    if (l) {
      const status = mapState(l.state);
      const error = l.error ? (await redact(env, l.error)).slice(0, 1000) : null;
      if (status !== row.status || error !== row.error || l.auth_url !== row.auth_url) await saveStatus(db, agentId, row.server_id, status, l.auth_url, error);
      view = { ...row, status, error, auth_url: l.auth_url };
    }
    out.push({
      ...view,
      name: server?.name ?? row.server_id,
      url: server?.url ?? "",
      auth: server?.auth ?? "none",
      policy: server?.policy ?? "off",
      description: server?.description ?? "",
      tools: live.tools.filter((t) => t.server_id === row.server_id),
    });
  }
  return { servers: out };
}

// What agents see (mcps_list): servers, policy and where they're attached. Never secrets.
export async function listForAgents(db: D1Database, agentId?: string) {
  const servers = await listServers(db);
  return {
    servers: servers
      .filter((s) => s.policy !== "off")
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        auth: s.auth,
        policy: s.policy,
        ready_to_attach: s.missing_secrets.length === 0,
        agents: s.agents.filter((a) => !agentId || a.agent_id === agentId).map((a) => ({ agent: a.agent_id, status: a.status })),
      })),
    hint: "Agents can attach servers with policy allowed and no OAuth (mcps_attach). OAuth servers are connected by the human.",
  };
}

// ---- import / export (editor-style JSON, SPEC-mcps 2) -----------------------------------------

export interface ImportPreview {
  servers: Array<{
    id: string;
    name: string;
    url: string;
    transport: Transport;
    auth: AuthKind;
    headers: Record<string, string>;
    exists: boolean;
    extracted: string[]; // secrets created from literal values in the JSON
  }>;
  skipped: Array<{ name: string; reason: string }>;
  missing_secrets: string[];
}

type Parsed = { preview: ImportPreview; values: Map<string, string> };

function parseImportJson(text: string): Record<string, Record<string, unknown>> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ServiceError("invalid_input", "Not valid JSON", "Paste the whole file, e.g. { \"mcpServers\": { ... } }.");
  }
  const root = data as Record<string, unknown>;
  const map = (root?.mcpServers ?? root?.servers ?? (root?.mcp as Record<string, unknown> | undefined)?.servers) as unknown;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new ServiceError("invalid_input", "No servers found", "Expected an mcpServers (Claude, Cursor) or servers (VS Code) object.");
  }
  return map as Record<string, Record<string, unknown>>;
}

function slug(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return /^[a-z]/.test(id) ? id : `mcp-${id}`.slice(0, 48);
}

async function parseImport(db: D1Database, text: string): Promise<Parsed> {
  const entries = parseImportJson(text);
  const known = await secretNames(db);
  const { results } = await db.prepare("SELECT id FROM mcp_servers").all<{ id: string }>();
  const existing = new Set(results.map((r) => r.id));
  const values = new Map<string, string>();
  const preview: ImportPreview = { servers: [], skipped: [], missing_secrets: [] };
  const missing = new Set<string>();
  for (const [name, raw] of Object.entries(entries)) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const url = (e.url ?? e.serverUrl) as string | undefined;
    if (e.command || !url) {
      preview.skipped.push({ name, reason: e.command ? "stdio server (runs a local command); only remote servers are supported" : "no url" });
      continue;
    }
    const id = slug(name);
    try {
      cleanUrl(url);
    } catch (err) {
      preview.skipped.push({ name, reason: err instanceof ServiceError ? err.message : "invalid url" });
      continue;
    }
    const type = String(e.type ?? e.transport ?? "").toLowerCase();
    const transport: Transport = type === "sse" ? "sse" : type === "http" || type === "streamable-http" || type === "streamablehttp" ? "streamable-http" : "auto";
    const headers: Record<string, string> = {};
    const extracted: string[] = [];
    for (const [h, v] of Object.entries((e.headers ?? {}) as Record<string, unknown>)) {
      if (typeof v !== "string" || !HEADER_RE.test(h)) continue;
      let template = normalizeTemplate(v);
      if (referencedSecrets({ [h]: template }).length === 0 && SENSITIVE_HEADER.test(h)) {
        // A literal credential: keep it as a new secret, store only the reference.
        const secret = `${id}_${h}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
        const bearer = template.match(/^(Bearer|Token|Basic)\s+(.+)$/i);
        values.set(secret, bearer ? bearer[2]! : template);
        template = bearer ? `${bearer[1]} \${${secret}}` : `\${${secret}}`;
        extracted.push(secret);
      }
      headers[h] = template;
    }
    for (const s of referencedSecrets(headers)) if (!known.has(s) && !values.has(s)) missing.add(s);
    preview.servers.push({
      id,
      name,
      url: new URL(url).href,
      transport,
      auth: Object.keys(headers).length ? "headers" : "none",
      headers,
      exists: existing.has(id),
      extracted,
    });
  }
  preview.missing_secrets = [...missing];
  return { preview, values };
}

export async function previewImport(db: D1Database, caller: Caller, text: string): Promise<ImportPreview> {
  requireHuman(caller, "imports MCP servers");
  return (await parseImport(db, text)).preview;
}

export async function importServers(env: Env, caller: Caller, text: string, opts: { replace?: boolean } = {}) {
  requireHuman(caller, "imports MCP servers");
  const db = env.DB_CORE;
  const { preview, values } = await parseImport(db, text);
  // Secrets first: a missing key fails here, before any server is created.
  for (const [name, value] of values) await putSecret(env, caller, name, value, "Imported with an MCP server");
  const created: string[] = [];
  const skipped = [...preview.skipped];
  for (const s of preview.servers) {
    if (s.exists && !opts.replace) {
      skipped.push({ name: s.name, reason: `a server with id ${s.id} exists` });
      continue;
    }
    if (s.exists) {
      const current = await getServer(db, s.id);
      if (current.builtin) {
        skipped.push({ name: s.name, reason: "same id as a Cloudflare server" });
        continue;
      }
      await updateServer(db, caller, s.id, { name: s.name, url: s.url, transport: s.transport, auth: s.auth, headers: s.headers });
    } else {
      await createServer(db, caller, { id: s.id, name: s.name, url: s.url, transport: s.transport, auth: s.auth, headers: s.headers });
    }
    created.push(s.id);
  }
  return { imported: created, skipped, missing_secrets: preview.missing_secrets, secrets_created: [...values.keys()] };
}

// Editor-style JSON with ${SECRET} references (never values). Builtins included.
export async function exportServers(db: D1Database) {
  const servers = await listServers(db);
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.id] = {
      type: s.transport === "sse" ? "sse" : "http",
      url: s.url,
      ...(Object.keys(s.headers).length ? { headers: s.headers } : {}),
    };
  }
  return { mcpServers };
}
