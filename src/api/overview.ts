// REST for the Overview (SPEC-ui section 4): counters, the agent tree with live status, activity.

import { listAgents } from "../services/agents";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export interface OverviewAgent {
  id: string;
  name: string;
  tier: string;
  parent_id: string | null;
  area: string;
  model: string;
  status: "working" | "idle";
  current_task: { identifier: string; title: string } | null;
  open_tasks: number;
}

async function overview(env: Env) {
  const db = env.DB_CORE;
  const [agents, running, counts] = await Promise.all([
    listAgents(db),
    db
      .prepare("SELECT assignee, identifier, title FROM tasks WHERE state = 'in_progress' ORDER BY updated_at DESC")
      .all<{ assignee: string; identifier: string; title: string }>(),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM projects) AS projects,
           (SELECT COUNT(*) FROM tasks WHERE state IN ('todo', 'in_progress', 'review')) AS open_tasks,
           (SELECT COUNT(*) FROM tasks WHERE state = 'review') AS review`,
      )
      .first<{ projects: number; open_tasks: number; review: number }>(),
  ]);

  const current = new Map<string, { identifier: string; title: string }>();
  for (const r of running.results) if (!current.has(r.assignee)) current.set(r.assignee, { identifier: r.identifier, title: r.title });

  const list: OverviewAgent[] = agents.map((a) => ({
    id: a.id,
    name: a.name,
    tier: a.tier,
    parent_id: a.parent_id,
    area: a.area,
    model: a.model,
    status: current.has(a.id) ? "working" : "idle",
    current_task: current.get(a.id) ?? null,
    open_tasks: a.open_tasks,
  }));

  return {
    counts: {
      agents: list.length,
      working: list.filter((a) => a.status === "working").length,
      projects: counts?.projects ?? 0,
      open_tasks: counts?.open_tasks ?? 0,
      review: counts?.review ?? 0,
    },
    agents: list,
  };
}

// Recent events from tasks, comments and reports, newest first.
async function activity(env: Env, limit: number) {
  const { results } = await env.DB_CORE.prepare(
    `SELECT * FROM (
       SELECT t.created_at AS at, 'task_created' AS kind, t.identifier, t.title, t.created_by AS actor, NULL AS detail
         FROM tasks t
       UNION ALL
       SELECT t.closed_at, CASE t.state WHEN 'done' THEN 'task_done' ELSE 'task_cancelled' END, t.identifier, t.title, NULL, NULL
         FROM tasks t WHERE t.closed_at IS NOT NULL
       UNION ALL
       SELECT c.created_at, 'comment', t.identifier, t.title, c.author, substr(c.body, 1, 160)
         FROM task_comments c JOIN tasks t ON t.id = c.task_id
       UNION ALL
       SELECT r.created_at, 'report', t.identifier, t.title, r.agent_id, r.title
         FROM task_artifacts r JOIN tasks t ON t.id = r.task_id
     ) ORDER BY at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return { events: results };
}

export async function handleOverviewApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/overview" && pathname !== "/api/activity") return null;
  if (request.method !== "GET") return json({ error: "Method not allowed", code: "method_not_allowed", hint: "Use GET." }, 405);
  try {
    if (pathname === "/api/overview") return json(await overview(env));
    const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") ?? 20) || 20, 1), 100);
    return json(await activity(env, limit));
  } catch (err) {
    console.error("overview api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
