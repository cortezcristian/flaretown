// REST for tasks under /api/tasks (SPEC-api section 4). REST callers are the human (behind Access).

import { afterSubtaskFinished, pokeOrchestrator, startAgentOnTask } from "../runtime";
import { listReports, readReport } from "../services/artifacts";
import { getBoard } from "../services/board";
import { HUMAN } from "../services/caller";
import { getOrchestratorSettings } from "../services/settings";
import { ServiceError } from "../services/errors";
import {
  cancelTask,
  checkCriterion,
  closeTask,
  commentTask,
  createTask,
  getTask,
  listTasks,
  sendBackTask,
  startTask,
  updateTask,
  type TaskFilter,
} from "../services/tasks";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    throw new ServiceError("invalid_input", "Body must be JSON", "Send Content-Type: application/json with a JSON object.");
  }
}

const methodNotAllowed = () =>
  json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method for this endpoint." }, 405);

// Returns null when the path is not a tasks route.
export async function handleTasksApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(/^\/api\/tasks(?:\/([^/]+)(?:\/(comments|close|send-back|cancel|run|criteria|reports)(?:\/([^/]+))?)?)?\/?$/);
  if (!match) return null;
  const [, taskRef, action, position] = match;
  const db = env.DB_CORE;
  const method = request.method;

  try {
    if (!taskRef) {
      if (method === "GET" && new URL(request.url).searchParams.get("view") === "board") {
        const p = new URL(request.url).searchParams;
        const days = Number((p.get("since") ?? "7d").replace(/d$/, "")) || 7;
        return json(
          await getBoard(db, {
            days,
            project_id: p.get("project_id") ?? undefined,
            agent: p.get("agent") ?? undefined,
            team: p.get("team") === "1",
            mine: p.get("mine") === "1",
            q: p.get("q") ?? undefined,
          }),
        );
      }
      if (method === "GET") {
        const url = new URL(request.url);
        const filter = (url.searchParams.get("filter") ?? "open") as TaskFilter;
        return json(
          await listTasks(db, {
            filter,
            project_id: url.searchParams.get("project_id") ?? undefined,
            assignee: url.searchParams.get("assignee") ?? undefined,
          }),
        );
      }
      if (method === "POST") {
        const body = await readJson(request);
        const task = await createTask(db, HUMAN, body as never);
        pokeOrchestrator(env);
        return json(task, 201);
      }
      return methodNotAllowed();
    }

    if (!action) {
      if (method === "GET") return json(await getTask(db, taskRef));
      if (method === "PATCH") {
        const task = await updateTask(db, HUMAN, taskRef, (await readJson(request)) as never);
        pokeOrchestrator(env);
        return json(task);
      }
      return methodNotAllowed();
    }

    if (method === "POST" && action === "comments") {
      const body = await readJson(request);
      return json(await commentTask(db, HUMAN, taskRef, String(body.body ?? "")), 201);
    }
    if (method === "POST" && action === "close") {
      const task = await closeTask(db, HUMAN, taskRef);
      afterSubtaskFinished(env, task);
      return json(task);
    }
    if (method === "POST" && action === "cancel") {
      const task = await cancelTask(db, HUMAN, taskRef);
      afterSubtaskFinished(env, task);
      return json(task);
    }
    if (method === "POST" && action === "run") {
      // Run now: claim the task (skipping the queue), then its agent works on it in its chat.
      const { max_concurrent_per_agent } = await getOrchestratorSettings(db);
      const task = await startTask(db, HUMAN, taskRef, { maxConcurrent: max_concurrent_per_agent });
      startAgentOnTask(env, task.assignee ?? "principal", task.identifier);
      return json(task, 202);
    }
    if (method === "POST" && action === "send-back") {
      const body = await readJson(request);
      const task = await sendBackTask(db, HUMAN, taskRef, String(body.reason ?? ""));
      if (task.assignee && task.assignee !== "principal") startAgentOnTask(env, task.assignee, task.identifier);
      return json(task);
    }
    if (method === "GET" && action === "reports") {
      if (position) return json(await readReport(env, taskRef, decodeURIComponent(position)));
      return json({ reports: await listReports(db, taskRef) });
    }
    if (method === "PATCH" && action === "criteria" && position) {
      const body = await readJson(request);
      return json(await checkCriterion(db, HUMAN, taskRef, Number(position), Boolean(body.checked)));
    }
    return methodNotAllowed();
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("tasks api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
