// REST for the Containers section (task 014): one container per agent, list / stop / resets.

import { agentStub } from "../runtime";
import { ServiceError } from "../services/errors";
import { getOrchestratorSettings } from "../services/settings";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const methodNotAllowed = () => json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method." }, 405);

export async function handleContainersApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/containers")) return null;
  try {
    if (pathname === "/api/containers/images") {
      if (request.method !== "GET") return methodNotAllowed();
      // Every agent class lists the same images (wrangler.jsonc); ask the Principal.
      return json({ images: await (await agentStub(env, "principal")).containerImages() });
    }

    if (pathname === "/api/containers") {
      if (request.method !== "GET") return methodNotAllowed();
      const { results } = await env.DB_CORE.prepare(
        `SELECT id, name, tier, parent_id, sandbox_last_used_at FROM agents
         WHERE status = 'active' AND (sandbox_enabled = 1 OR sandbox_last_used_at IS NOT NULL)
         ORDER BY CASE tier WHEN 'principal' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END, created_at`,
      ).all<{ id: string; name: string; tier: string; parent_id: string | null; sandbox_last_used_at: string | null }>();
      const containers = await Promise.all(
        results.map(async (a) => {
          const status = await (await agentStub(env, a.id))
            .sandboxStatus()
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
          return { agent: a, last_used_at: a.sandbox_last_used_at, status };
        }),
      );
      const settings = await getOrchestratorSettings(env.DB_CORE);
      const running = (tier: string) =>
        containers.filter((c) => c.agent.tier === tier && (c.status as { running?: boolean }).running).length;
      return json({
        containers,
        global_enabled: settings.sandbox_global_enabled,
        tiers: {
          principal: { running: running("principal"), max: settings.sandbox_max_principal },
          lead: { running: running("lead"), max: settings.sandbox_max_leads },
          operator: { running: running("operator"), max: settings.sandbox_max_operators },
        },
      });
    }

    const action = pathname.match(/^\/api\/containers\/([a-z0-9-]+)\/(start|stop|reset|reset-profile)$/);
    if (action) {
      if (request.method !== "POST") return methodNotAllowed();
      const stub = await agentStub(env, action[1]!);
      if (action[2] === "start") return json(await stub.containerBoot());
      if (action[2] === "stop") return json(await stub.containerStop());
      if (action[2] === "reset") return json(await stub.sandboxReset());
      return json(await stub.containerResetProfile());
    }

    return json({ error: "Not found", code: "not_found", hint: "Unknown containers route." }, 404);
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("containers api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
