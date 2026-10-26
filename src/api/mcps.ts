// REST for the MCPs section (task 018, SPEC-mcps): servers, agent attachments and secrets.
// Secrets are write-only: no route returns a value.

import { HUMAN } from "../services/caller";
import { ServiceError } from "../services/errors";
import {
  agentMcpStatus,
  attachServer,
  createServer,
  deleteServer,
  detachServer,
  exportServers,
  getServer,
  importServers,
  listServers,
  previewImport,
  reconnectServer,
  serversUsingSecret,
  updateServer,
} from "../services/mcps";
import { deleteSecret, listSecrets, putSecret, reencryptAll, secretsStatus } from "../services/secrets";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const methodNotAllowed = () => json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method." }, 405);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function serverInput(b: Record<string, unknown>) {
  return {
    id: str(b.id),
    name: str(b.name),
    url: str(b.url),
    transport: str(b.transport),
    auth: str(b.auth),
    headers: b.headers && typeof b.headers === "object" && !Array.isArray(b.headers) ? (b.headers as Record<string, unknown>) : undefined,
    policy: str(b.policy),
    description: str(b.description),
  };
}

async function route(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const db = env.DB_CORE;
  const method = request.method;
  const origin = new URL(request.url).origin;

  // ---- secrets ----
  if (pathname === "/api/secrets") {
    if (method !== "GET") return methodNotAllowed();
    return json(await listSecrets(env));
  }
  if (pathname === "/api/secrets/status") {
    if (method !== "GET") return methodNotAllowed();
    return json(await secretsStatus(env));
  }
  if (pathname === "/api/secrets/reencrypt") {
    if (method !== "POST") return methodNotAllowed();
    return json(await reencryptAll(env, HUMAN));
  }
  const secret = pathname.match(/^\/api\/secrets\/([A-Za-z0-9_]+)$/);
  if (secret) {
    const name = secret[1]!;
    if (method === "PUT") {
      const b = await readJson(request);
      if (typeof b.value !== "string") throw new ServiceError("invalid_input", "value is required", "");
      await putSecret(env, HUMAN, name, b.value, str(b.description));
      // Never echo the value; tell the UI which servers to reconnect.
      return json({ ok: true, name, servers: await serversUsingSecret(db, name) });
    }
    if (method === "DELETE") {
      await deleteSecret(env, HUMAN, name);
      return json({ ok: true });
    }
    return methodNotAllowed();
  }

  // ---- an agent's servers ----
  const agentPath = pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/mcps(?:\/([a-z0-9-]+))?$/);
  if (agentPath) {
    const [, agentId, serverId] = agentPath as unknown as [string, string, string | undefined];
    if (!serverId) {
      if (method === "GET") return json(await agentMcpStatus(env, agentId));
      if (method === "POST") {
        const b = await readJson(request);
        if (typeof b.server !== "string") throw new ServiceError("invalid_input", "server is required", "The MCP server id.");
        return json(await attachServer(env, HUMAN, agentId, b.server, { origin }), 201);
      }
      return methodNotAllowed();
    }
    if (method === "DELETE") return json(await detachServer(env, HUMAN, agentId, serverId));
    if (method === "POST") return json(await attachServer(env, HUMAN, agentId, serverId, { origin })); // reconnect
    return methodNotAllowed();
  }

  if (!pathname.startsWith("/api/mcps")) return null;

  // ---- servers ----
  if (pathname === "/api/mcps") {
    if (method === "GET") return json({ servers: await listServers(db), secrets: await secretsStatus(env) });
    if (method === "POST") return json(await createServer(db, HUMAN, serverInput(await readJson(request))), 201);
    return methodNotAllowed();
  }
  if (pathname === "/api/mcps/export") {
    if (method !== "GET") return methodNotAllowed();
    return json(await exportServers(db));
  }
  if (pathname === "/api/mcps/import/preview" || pathname === "/api/mcps/import") {
    if (method !== "POST") return methodNotAllowed();
    const b = await readJson(request);
    if (typeof b.json !== "string") throw new ServiceError("invalid_input", "json is required", "Paste the editor config as text.");
    if (b.json.length > 200_000) throw new ServiceError("invalid_input", "Too large", "Max 200 KB.");
    if (pathname.endsWith("/preview")) return json(await previewImport(db, HUMAN, b.json));
    return json(await importServers(env, HUMAN, b.json, { replace: b.replace === true }));
  }
  const m = pathname.match(/^\/api\/mcps\/([a-z0-9-]+)(?:\/(reconnect))?$/);
  if (!m) return json({ error: "Not found", code: "not_found", hint: "Unknown MCPs route." }, 404);
  const [, id, action] = m as unknown as [string, string, string | undefined];
  if (action === "reconnect") {
    if (method !== "POST") return methodNotAllowed();
    return json({ agents: await reconnectServer(env, HUMAN, id, { origin }) });
  }
  if (method === "GET") return json(await getServer(db, id));
  if (method === "PATCH") return json(await updateServer(db, HUMAN, id, serverInput(await readJson(request))));
  if (method === "DELETE") {
    await deleteServer(env, HUMAN, id);
    return json({ ok: true });
  }
  return methodNotAllowed();
}

export async function handleMcpsApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/mcps") && !pathname.startsWith("/api/secrets") && !/^\/api\/agents\/[a-z0-9-]+\/mcps/.test(pathname)) return null;
  try {
    return await route(request, env, pathname);
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("mcps api error", err instanceof Error ? err.message : "unknown");
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
