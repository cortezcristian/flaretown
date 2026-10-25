// REST for the Orchestrator section (SPEC-orchestrator 6.6).

import { orchestratorStub } from "../runtime";
import { ServiceError } from "../services/errors";
import { getOrchestratorSettings, updateOrchestratorSettings } from "../services/settings";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleOrchestratorApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/orchestrator" && pathname !== "/api/orchestrator/tick") return null;
  const stub = orchestratorStub(env);
  try {
    if (pathname === "/api/orchestrator/tick") {
      if (request.method !== "POST") return json({ error: "Method not allowed", code: "method_not_allowed", hint: "Use POST." }, 405);
      return json(await stub.tickNow());
    }
    if (request.method === "GET") {
      return json({ settings: await getOrchestratorSettings(env.DB_CORE), status: await stub.status() });
    }
    if (request.method === "PATCH") {
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        throw new ServiceError("invalid_input", "Body must be JSON", "Send a JSON object.");
      }
      const patch: Record<string, unknown> = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.code_mode_enabled === "boolean") patch.code_mode_enabled = body.code_mode_enabled;
      if (typeof body.sandbox_global_enabled === "boolean") patch.sandbox_global_enabled = body.sandbox_global_enabled;
      for (const k of [
        "poll_interval_s",
        "max_concurrent_per_agent",
        "stall_timeout_min",
        "sandbox_max_principal",
        "sandbox_max_leads",
        "sandbox_max_operators",
      ]) {
        if (body[k] !== undefined) patch[k] = Number(body[k]);
      }
      const settings = await updateOrchestratorSettings(env.DB_CORE, patch);
      await stub.reschedule();
      if (settings.enabled) await stub.poke();
      return json({ settings, status: await stub.status() });
    }
    return json({ error: "Method not allowed", code: "method_not_allowed", hint: "Use GET or PATCH." }, 405);
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("orchestrator api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
