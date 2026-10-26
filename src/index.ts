// Flaretown main Worker.
// Routing rules (SPEC-api 1.1): internal REST under /api/*, internal MCP under /mcp/*,
// everything else is the static UI.

import { handleAgentsApi } from "./api/agents";
import { handleArtifactsApi } from "./api/artifacts";
import { handleContainersApi } from "./api/containers";
import { handleDecisionsApi } from "./api/decisions";
import { handleMcpsApi } from "./api/mcps";
import { handleSkillsApi } from "./api/skills";
import { handleOrchestratorApi } from "./api/orchestrator";
import { handleOverviewApi } from "./api/overview";
import { handleProjectsApi } from "./api/projects";
import { handleRoutinesApi } from "./api/routines";
import { handleTasksApi } from "./api/tasks";
import { MCP_AGENTS_ROUTE, mcpAgentsHandler } from "./mcp/agents";
import { agentChatStub } from "./runtime";

export { Lead } from "./agents/lead";
export { Operator } from "./agents/operator";
export { Principal } from "./agents/principal";
export { Orchestrator } from "./orchestrator";
export { ProfileSync } from "./profileSync";
export { Scheduler } from "./scheduler";

type ErrorBody = { error: string; code: string; hint: string };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function notFound(hint: string): Response {
  const body: ErrorBody = { error: "Not found", code: "not_found", hint };
  return json(body, 404);
}

async function dbReachable(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}

async function health(env: Env): Promise<Response> {
  const [core, runs] = await Promise.all([dbReachable(env.DB_CORE), dbReachable(env.DB_RUNS)]);
  const ok = core && runs;
  return json(
    {
      ok,
      version: env.CF_VERSION_METADATA.id,
      databases: { core, runs },
    },
    ok ? 200 : 503,
  );
}

// Chat with any agent (WebSocket + HTTP): /api/agents/<agent-id>/chat[/...]
const CHAT_PATH = /^\/api\/agents\/([a-z0-9-]+)\/chat(?:\/.*)?$/;
// A container's desktop (noVNC, HTTP + WebSocket), same origin as the UI: /container/<agent-id>/view[/...]
const VIEW_PATH = /^\/container\/([a-z0-9-]+)\/view(\/.*)?$/;
// OAuth callback of an MCP server attached to an agent (task 018): finished in that agent's DO.
const MCP_OAUTH_PATH = /^\/mcp\/oauth\/callback\/([a-z0-9-]+)\/[a-z0-9-]+$/;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed", code: "method_not_allowed", hint: "Use GET." }, 405);
      }
      return health(env);
    }

    const chat = pathname.match(CHAT_PATH);
    if (chat) {
      const stub = await agentChatStub(env, chat[1]!);
      return stub ? stub.fetch(request) : notFound(`No agent ${chat[1]}.`);
    }

    const view = pathname.match(VIEW_PATH);
    if (view) {
      const id = view[1]!;
      if (!view[2] || view[2] === "/") {
        const base = `container/${id}/view`;
        return Response.redirect(new URL(`/${base}/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=${base}/websockify`, request.url).toString(), 302);
      }
      const stub = await agentChatStub(env, id);
      return stub ? stub.fetch(request) : notFound(`No agent ${id}.`);
    }

    const oauth = pathname.match(MCP_OAUTH_PATH);
    if (oauth) {
      const stub = await agentChatStub(env, oauth[1]!);
      return stub ? stub.fetch(request) : notFound(`No agent ${oauth[1]}.`);
    }

    const apiResponse =
      (await handleMcpsApi(request, env, pathname)) ??
      (await handleContainersApi(request, env, pathname)) ??
      (await handleDecisionsApi(request, env, pathname)) ??
      (await handleSkillsApi(request, env, pathname)) ??
      (await handleArtifactsApi(request, env, pathname)) ??
      (await handleTasksApi(request, env, pathname)) ??
      (await handleProjectsApi(request, env, pathname)) ??
      (await handleAgentsApi(request, env, pathname)) ??
      (await handleOrchestratorApi(request, env, pathname)) ??
      (await handleOverviewApi(request, env, pathname)) ??
      (await handleRoutinesApi(request, env, pathname));
    if (apiResponse) return apiResponse;

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return notFound(`No API route for ${pathname}.`);
    }

    if (pathname === MCP_AGENTS_ROUTE || pathname.startsWith(`${MCP_AGENTS_ROUTE}/`)) {
      return mcpAgentsHandler(request, env, ctx);
    }

    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      return notFound(`No MCP server at ${pathname} yet.`);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
