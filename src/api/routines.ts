// REST for routines (SPEC-sections-view section 6). REST callers are the human.

import { rescheduleRoutines, schedulerStub } from "../runtime";
import { HUMAN } from "../services/caller";
import { ServiceError } from "../services/errors";
import {
  createRoutine,
  deleteRoutine,
  describeSchedule,
  getRoutine,
  listRoutines,
  nextRuns,
  normalizeSchedule,
  requireCanRun,
  type RoutineInput,
  type ScheduleKind,
  updateRoutine,
} from "../services/routines";

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

function toInput(b: Record<string, unknown>): RoutineInput {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    name: str(b.name),
    owner_id: str(b.owner_id),
    schedule_kind: str(b.schedule_kind) as ScheduleKind | undefined,
    cron: b.cron === null ? null : str(b.cron),
    interval_minutes: b.interval_minutes === null ? null : b.interval_minutes === undefined ? undefined : Number(b.interval_minutes),
    timezone: str(b.timezone),
    prompt: str(b.prompt),
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
  };
}

const methodNotAllowed = () => json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method." }, 405);

export async function handleRoutinesApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = pathname.match(/^\/api\/routines(?:\/([^/]+)(?:\/(run))?)?\/?$/);
  if (!m) return null;
  const [, id, action] = m;
  const db = env.DB_CORE;
  try {
    if (id === "preview") {
      if (request.method !== "POST") return methodNotAllowed();
      const b = toInput(await readJson(request));
      const sched = normalizeSchedule({ kind: b.schedule_kind ?? "cron", cron: b.cron, interval_minutes: b.interval_minutes, timezone: b.timezone });
      return json({ schedule_text: describeSchedule(sched), next_runs: nextRuns(sched, new Date(), 3).map((d) => d.toISOString()) });
    }
    if (!id) {
      if (request.method === "GET") {
        const owner = new URL(request.url).searchParams.get("owner_id") ?? undefined;
        return json({ routines: await listRoutines(db, { owner_id: owner }) });
      }
      if (request.method === "POST") {
        const r = await createRoutine(db, HUMAN, toInput(await readJson(request)));
        rescheduleRoutines(env);
        return json(r, 201);
      }
      return methodNotAllowed();
    }
    if (action === "run") {
      if (request.method !== "POST") return methodNotAllowed();
      const r = await requireCanRun(db, HUMAN, id);
      return json(await schedulerStub(env).runNow(r.id));
    }
    if (request.method === "GET") return json(await getRoutine(db, id));
    if (request.method === "PATCH") {
      const r = await updateRoutine(db, HUMAN, id, toInput(await readJson(request)));
      rescheduleRoutines(env);
      return json(r);
    }
    if (request.method === "DELETE") {
      const r = await deleteRoutine(db, HUMAN, id);
      rescheduleRoutines(env);
      return json(r);
    }
    return methodNotAllowed();
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("routines api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs (missing migration?)." }, 500);
  }
}
