// Routines: recurring work owned by an agent (SPEC-agents section 7).
// Schedules: cron (5 fields + timezone, via croner), every N minutes, or manual only.

import { Cron } from "croner";
import { type Caller, callerName } from "./caller";
import { ServiceError } from "./errors";

export type ScheduleKind = "cron" | "interval" | "manual";

export interface Schedule {
  kind: ScheduleKind;
  cron?: string | null;
  interval_minutes?: number | null;
  timezone?: string;
}

export interface Routine {
  id: string;
  name: string;
  owner_id: string;
  schedule_kind: ScheduleKind;
  cron: string | null;
  interval_minutes: number | null;
  timezone: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RoutineView extends Omit<Routine, "enabled"> {
  enabled: boolean;
  owner_name: string;
  schedule_text: string;
}

export interface RoutineRun {
  id: string;
  routine_id: string;
  task_id: string | null;
  task_identifier: string | null;
  task_state: string | null;
  status: "started" | "skipped" | "failed";
  reason: string | null;
  trigger: "schedule" | "manual";
  at: string;
}

export const MIN_INTERVAL_MINUTES = 5;

function forbidden(rule: string, hint: string) {
  return new ServiceError("forbidden", `Not allowed: ${rule}`, hint, 403);
}

// ---- schedules ------------------------------------------------------------------------------

function checkTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    throw new ServiceError("invalid_input", `Unknown timezone ${tz}`, "Use an IANA name, e.g. Europe/Dublin or America/Argentina/Buenos_Aires.");
  }
}

export function normalizeSchedule(s: Schedule): Required<Schedule> {
  const timezone = (s.timezone || "UTC").trim();
  checkTimezone(timezone);
  if (s.kind === "cron") {
    const cron = (s.cron ?? "").trim().replace(/\s+/g, " ");
    if (cron.split(" ").length !== 5) {
      throw new ServiceError("invalid_input", "Cron needs 5 fields", "minute hour day month weekday, e.g. 0 8 * * * for every day at 08:00.");
    }
    try {
      new Cron(cron, { timezone, paused: true });
    } catch (err) {
      throw new ServiceError("invalid_input", `Invalid cron: ${cron}`, err instanceof Error ? err.message : "Check the expression.");
    }
    return { kind: "cron", cron, interval_minutes: null, timezone };
  }
  if (s.kind === "interval") {
    const n = Number(s.interval_minutes);
    if (!Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > 60 * 24 * 31) {
      throw new ServiceError("invalid_input", "Interval out of range", `Use ${MIN_INTERVAL_MINUTES} minutes to 31 days.`);
    }
    return { kind: "interval", cron: null, interval_minutes: n, timezone };
  }
  if (s.kind === "manual") return { kind: "manual", cron: null, interval_minutes: null, timezone };
  throw new ServiceError("invalid_input", `Unknown schedule ${String(s.kind)}`, "Use cron, interval or manual.");
}

export function nextRuns(s: Schedule, from: Date, n: number): Date[] {
  const sched = normalizeSchedule(s);
  if (sched.kind === "manual") return [];
  if (sched.kind === "interval") {
    return Array.from({ length: n }, (_, i) => new Date(from.getTime() + (i + 1) * sched.interval_minutes! * 60_000));
  }
  return new Cron(sched.cron!, { timezone: sched.timezone, paused: true }).nextRuns(n, from);
}

// Reject cron expressions that fire more often than every 5 minutes.
function checkMinimumGap(s: Schedule) {
  if (s.kind !== "cron") return;
  const runs = nextRuns(s, new Date(), 6);
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_INTERVAL_MINUTES * 60_000) {
      throw new ServiceError("invalid_input", "Runs too often", `Routines run at most every ${MIN_INTERVAL_MINUTES} minutes.`);
    }
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function describeSchedule(s: Schedule): string {
  if (s.kind === "manual") return "manual only";
  if (s.kind === "interval") {
    const m = s.interval_minutes ?? 0;
    if (m % 1440 === 0) return `every ${m / 1440} day${m === 1440 ? "" : "s"}`;
    if (m % 60 === 0) return `every ${m / 60} h`;
    return `every ${m} min`;
  }
  const [min, hour, dom, mon, dow] = (s.cron ?? "").split(" ");
  const tz = s.timezone && s.timezone !== "UTC" ? ` ${s.timezone}` : " UTC";
  const isNum = (v?: string) => v !== undefined && /^\d+$/.test(v);
  if (isNum(min) && isNum(hour) && dom === "*" && mon === "*") {
    const at = `${pad(Number(hour))}:${pad(Number(min))}${tz}`;
    if (dow === "*") return `every day at ${at}`;
    if (dow === "1-5") return `weekdays at ${at}`;
    if (dow === "0,6" || dow === "6,0") return `weekends at ${at}`;
  }
  const everyH = hour?.match(/^\*\/(\d+)$/);
  if (isNum(min) && everyH && dom === "*" && mon === "*" && dow === "*") return `every ${everyH[1]} h at :${pad(Number(min))}`;
  return `cron ${s.cron}${tz}`;
}

// ---- permissions (SPEC-agents 7.2) ----------------------------------------------------------

async function requireCanManage(db: D1Database, caller: Caller, ownerId: string) {
  if (caller.kind === "human" || caller.kind === "system") return;
  const owner = await db.prepare("SELECT id, tier, parent_id FROM agents WHERE id = ?").bind(ownerId).first<{ id: string; tier: string; parent_id: string | null }>();
  if (!owner) throw new ServiceError("not_found", `Agent ${ownerId} not found`, "Use an agent id from agents_list.", 404);
  const me = await db.prepare("SELECT tier FROM agents WHERE id = ?").bind(caller.id).first<{ tier: string }>();
  const ok =
    owner.id === caller.id ||
    (me?.tier === "principal" && owner.tier === "lead") ||
    (me?.tier === "lead" && owner.tier === "operator" && owner.parent_id === caller.id);
  if (!ok) {
    throw forbidden(
      "routines: Principal for itself and Leads, a Lead for itself and its Operators, an Operator for itself",
      `You can't manage routines for ${ownerId}.`,
    );
  }
}

// ---- read -----------------------------------------------------------------------------------

function view(r: Routine & { owner_name?: string }): RoutineView {
  return {
    ...r,
    enabled: Boolean(r.enabled),
    owner_name: r.owner_name ?? r.owner_id,
    schedule_text: describeSchedule({ kind: r.schedule_kind, cron: r.cron, interval_minutes: r.interval_minutes, timezone: r.timezone }),
  };
}

export async function listRoutines(db: D1Database, opts: { owner_id?: string } = {}): Promise<RoutineView[]> {
  const where = opts.owner_id ? "WHERE r.owner_id = ?" : "";
  const stmt = db.prepare(
    `SELECT r.*, a.name AS owner_name FROM routines r JOIN agents a ON a.id = r.owner_id ${where}
     ORDER BY r.enabled DESC, r.next_run_at IS NULL, r.next_run_at, r.name`,
  );
  const { results } = await (opts.owner_id ? stmt.bind(opts.owner_id) : stmt).all<Routine & { owner_name: string }>();
  return results.map(view);
}

export async function getRoutine(db: D1Database, id: string): Promise<RoutineView & { runs: RoutineRun[] }> {
  const r = await db
    .prepare("SELECT r.*, a.name AS owner_name FROM routines r JOIN agents a ON a.id = r.owner_id WHERE r.id = ?1 OR r.name = ?1")
    .bind(id)
    .first<Routine & { owner_name: string }>();
  if (!r) throw new ServiceError("not_found", `Routine ${id} not found`, "Use routines_list.", 404);
  const { results } = await db
    .prepare(
      `SELECT rr.*, t.identifier AS task_identifier, t.state AS task_state FROM routine_runs rr
       LEFT JOIN tasks t ON t.id = rr.task_id WHERE rr.routine_id = ? ORDER BY rr.at DESC LIMIT 20`,
    )
    .bind(r.id)
    .all<RoutineRun>();
  return { ...view(r), runs: results };
}

// ---- write ----------------------------------------------------------------------------------

export interface RoutineInput {
  name?: string;
  owner_id?: string;
  schedule_kind?: ScheduleKind;
  cron?: string | null;
  interval_minutes?: number | null;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
}

function computeNext(s: Schedule, enabled: boolean): string | null {
  if (!enabled) return null;
  const next = nextRuns(s, new Date(), 1)[0];
  return next ? next.toISOString() : null;
}

export async function createRoutine(db: D1Database, caller: Caller, input: RoutineInput): Promise<RoutineView> {
  const name = (input.name ?? "").trim();
  if (!name) throw new ServiceError("invalid_input", "Name is required", "Give the routine a short name.");
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) throw new ServiceError("invalid_input", "Prompt is required", "Say what the agent should do on each run.");
  const owner = input.owner_id ?? (caller.kind === "agent" ? caller.id : "");
  const agent = await db.prepare("SELECT status FROM agents WHERE id = ?").bind(owner).first<{ status: string }>();
  if (!agent || agent.status !== "active") throw new ServiceError("invalid_input", `Unknown agent ${owner}`, "Pick an active agent.");
  await requireCanManage(db, caller, owner);

  const sched = normalizeSchedule({ kind: input.schedule_kind ?? "cron", cron: input.cron, interval_minutes: input.interval_minutes, timezone: input.timezone });
  checkMinimumGap(sched);
  const enabled = input.enabled ?? true;
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO routines (id, name, owner_id, schedule_kind, cron, interval_minutes, timezone, prompt, enabled, next_run_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, name, owner, sched.kind, sched.cron, sched.interval_minutes, sched.timezone, prompt, enabled ? 1 : 0, computeNext(sched, enabled), callerName(caller), ts, ts)
    .run();
  return getRoutine(db, id);
}

export async function updateRoutine(db: D1Database, caller: Caller, id: string, input: RoutineInput): Promise<RoutineView> {
  const current = await getRoutine(db, id);
  await requireCanManage(db, caller, current.owner_id);
  if (input.owner_id && input.owner_id !== current.owner_id) {
    const agent = await db.prepare("SELECT status FROM agents WHERE id = ?").bind(input.owner_id).first<{ status: string }>();
    if (!agent || agent.status !== "active") throw new ServiceError("invalid_input", `Unknown agent ${input.owner_id}`, "Pick an active agent.");
    await requireCanManage(db, caller, input.owner_id);
  }
  const sched = normalizeSchedule({
    kind: input.schedule_kind ?? current.schedule_kind,
    cron: input.cron !== undefined ? input.cron : current.cron,
    interval_minutes: input.interval_minutes !== undefined ? input.interval_minutes : current.interval_minutes,
    timezone: input.timezone ?? current.timezone,
  });
  checkMinimumGap(sched);
  const enabled = input.enabled ?? current.enabled;
  const name = input.name !== undefined ? input.name.trim() || current.name : current.name;
  const prompt = input.prompt !== undefined ? input.prompt.trim() || current.prompt : current.prompt;
  await db
    .prepare(
      `UPDATE routines SET name = ?, owner_id = ?, schedule_kind = ?, cron = ?, interval_minutes = ?, timezone = ?, prompt = ?,
         enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      name, input.owner_id ?? current.owner_id, sched.kind, sched.cron, sched.interval_minutes, sched.timezone, prompt,
      enabled ? 1 : 0, computeNext(sched, enabled), new Date().toISOString(), current.id,
    )
    .run();
  return getRoutine(db, current.id);
}

export async function deleteRoutine(db: D1Database, caller: Caller, id: string): Promise<{ deleted: string }> {
  const current = await getRoutine(db, id);
  await requireCanManage(db, caller, current.owner_id);
  await db.batch([
    db.prepare("DELETE FROM routine_runs WHERE routine_id = ?").bind(current.id),
    db.prepare("DELETE FROM routines WHERE id = ?").bind(current.id),
  ]);
  return { deleted: current.id };
}

export async function requireCanRun(db: D1Database, caller: Caller, id: string): Promise<RoutineView> {
  const r = await getRoutine(db, id);
  await requireCanManage(db, caller, r.owner_id);
  return r;
}

// After a scheduled run: next time from now.
export async function advanceRoutine(db: D1Database, r: Routine | RoutineView): Promise<void> {
  const enabled = Boolean(r.enabled);
  const next = computeNext({ kind: r.schedule_kind, cron: r.cron, interval_minutes: r.interval_minutes, timezone: r.timezone }, enabled);
  await db.prepare("UPDATE routines SET last_run_at = ?, next_run_at = ? WHERE id = ?").bind(new Date().toISOString(), next, r.id).run();
}

export async function recordRun(
  db: D1Database,
  routineId: string,
  run: { status: RoutineRun["status"]; trigger: RoutineRun["trigger"]; task_id?: string | null; reason?: string | null },
) {
  await db
    .prepare("INSERT INTO routine_runs (id, routine_id, task_id, status, reason, trigger, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), routineId, run.task_id ?? null, run.status, run.reason ?? null, run.trigger, new Date().toISOString())
    .run();
}
