// REST for agents (SPEC-api section 4): list, create, get, delete (retire), config, and models.
// Chat routing (/api/agents/:id/chat) is in index.ts.

import { getAgentSkills, setAgentSkills } from "../services/skills";
import { MAIN_MODELS } from "../models";
import { agentStub, pokeOrchestrator, rescheduleRoutines } from "../runtime";
import { getAgentConfig, updateAgentConfig } from "../services/agentConfig";
import { createAgent, getAgent, listAgents, retireAgent } from "../services/agents";
import { HUMAN } from "../services/caller";
import { ServiceError } from "../services/errors";
import { ensureAgentRepo } from "../services/repos";
import { waitUntil } from "cloudflare:workers";

const ctxWait = (p: Promise<unknown>) => waitUntil(p.catch((err) => console.error("repo create failed", err)));

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    throw new ServiceError("invalid_input", "Body must be JSON", "Send a JSON object.");
  }
}

const methodNotAllowed = () => json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method." }, 405);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

export async function handleAgentsApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const db = env.DB_CORE;
  try {
    if (pathname === "/api/models") {
      if (request.method !== "GET") return methodNotAllowed();
      return json({ models: MAIN_MODELS });
    }

    if (pathname === "/api/agents") {
      if (request.method === "GET") {
        const all = new URL(request.url).searchParams.get("include") === "retired";
        return json({ agents: await listAgents(db, { includeRetired: all }) });
      }
      if (request.method === "POST") {
        const b = await readJson(request);
        const agent = await createAgent(db, HUMAN, {
          name: str(b.name) ?? "",
          type: str(b.type) ?? "",
          parent_id: str(b.parent_id),
          area: str(b.area),
          model: str(b.model),
          code_mode: typeof b.code_mode === "boolean" ? b.code_mode : undefined,
          sandbox_enabled: bool(b.sandbox_enabled),
          sandbox_internet: bool(b.sandbox_internet),
          sandbox_persist: bool(b.sandbox_persist),
          container_image: str(b.container_image),
          container_instance: str(b.container_instance),
        });
        if (Array.isArray(b.skills) && b.skills.length) {
          await setAgentSkills(db, HUMAN, agent.id, b.skills.filter((s): s is string => typeof s === "string"));
        }
        // Create its Artifacts repo now (also created lazily on first use).
        ctxWait(ensureAgentRepo(env, agent.id));
        return json(agent, 201);
      }
      return methodNotAllowed();
    }

    const config = pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/config$/);
    if (config) {
      const id = config[1]!;
      if (request.method === "GET") return json(await getAgentConfig(db, id));
      if (request.method === "PATCH") {
        const b = await readJson(request);
        const compact =
          b.compact_after_tokens === null ? null : b.compact_after_tokens === undefined ? undefined : Number(b.compact_after_tokens);
        const before = await getAgentConfig(db, id);
        const updated = await updateAgentConfig(db, id, {
          model: str(b.model),
          response_format: str(b.response_format),
          compact_after_tokens: compact,
          code_mode: typeof b.code_mode === "boolean" ? b.code_mode : undefined,
          sandbox_enabled: bool(b.sandbox_enabled),
          sandbox_internet: bool(b.sandbox_internet),
          sandbox_persist: bool(b.sandbox_persist),
          container_image: str(b.container_image),
          container_instance: b.container_instance === null ? null : str(b.container_instance),
        });
        const stub = await agentStub(env, id);
        // Apply the new model window / threshold to the running agent right away.
        await stub.applyConfig().catch((err) => console.error("applyConfig failed", err));
        // A running container keeps the Internet setting it started with: restart it so the next
        // command uses the new one. Turning the sandbox off stops it too.
        // Image or instance changed: restart; a snapshot of another image is dropped.
        const imageChanged = before.container_image !== updated.container_image;
        if (imageChanged || before.container_instance !== updated.container_instance) {
          await stub.containerChanged(imageChanged).catch((err) => console.error("container change failed", err));
        } else if (bool(b.sandbox_internet) !== undefined || b.sandbox_enabled === false) {
          await stub.sandboxRestart().catch((err) => console.error("sandbox restart failed", err));
        }
        return json(updated);
      }
      return methodNotAllowed();
    }

    // Sandbox status and controls (task 013).
    const sandbox = pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/sandbox(?:\/(restart|reset))?$/);
    if (sandbox) {
      const stub = await agentStub(env, sandbox[1]!);
      if (!sandbox[2]) {
        if (request.method !== "GET") return methodNotAllowed();
        return json(await stub.sandboxStatus());
      }
      if (request.method !== "POST") return methodNotAllowed();
      return json(sandbox[2] === "restart" ? await stub.sandboxRestart() : await stub.sandboxReset());
    }

    // Skills of one agent (task 017).
    const skillsPath = pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/skills$/);
    if (skillsPath) {
      if (request.method === "GET") return json(await getAgentSkills(db, skillsPath[1]!));
      if (request.method === "PUT") {
        const b = await readJson(request);
        const names = Array.isArray(b.skills) ? b.skills.filter((s): s is string => typeof s === "string") : [];
        return json(await setAgentSkills(db, HUMAN, skillsPath[1]!, names));
      }
      return methodNotAllowed();
    }

    const compact = pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/compact$/);
    if (compact) {
      if (request.method !== "POST") return methodNotAllowed();
      return json(await (await agentStub(env, compact[1]!)).compactNow());
    }

    const one = pathname.match(/^\/api\/agents\/([a-z0-9-]+)$/);
    if (one) {
      const id = one[1]!;
      if (request.method === "GET") return json(await getAgent(db, id));
      if (request.method === "DELETE") {
        const agent = await retireAgent(db, HUMAN, id);
        pokeOrchestrator(env);
        rescheduleRoutines(env);
        return json(agent);
      }
      return methodNotAllowed();
    }

    return null;
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("agents api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs (missing migration?)." }, 500);
  }
}
