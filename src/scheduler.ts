// Scheduler: fires routines when they are due (SPEC-agents section 7).
// One Durable Object instance with a single alarm at the earliest next_run_at.

import { DurableObject } from "cloudflare:workers";
import { startAgentOnTask } from "./runtime";
import { SYSTEM } from "./services/caller";
import { ServiceError } from "./services/errors";
import { retentionDue, runRetention } from "./services/retention";
import { advanceRoutine, getRoutine, recordRun, type Routine, type RoutineView } from "./services/routines";
import { createTask, startTask } from "./services/tasks";

// Runs one routine: a task for its owner with the prompt, started right away.
// Overlap: if the previous run's task is still open, the run is skipped.
export async function runRoutine(
  env: Env,
  routine: Routine | RoutineView,
  trigger: "schedule" | "manual",
): Promise<{ status: "started" | "skipped" | "failed"; task?: string; reason?: string }> {
  const db = env.DB_CORE;
  const open = await db
    .prepare(
      `SELECT t.identifier FROM routine_runs rr JOIN tasks t ON t.id = rr.task_id
       WHERE rr.routine_id = ? AND rr.status = 'started' AND t.state IN ('todo', 'in_progress', 'review')
       ORDER BY rr.at DESC LIMIT 1`,
    )
    .bind(routine.id)
    .first<{ identifier: string }>();
  if (open) {
    const reason = `previous run ${open.identifier} is still open`;
    await recordRun(db, routine.id, { status: "skipped", trigger, reason });
    return { status: "skipped", reason };
  }

  try {
    const when = new Intl.DateTimeFormat("en-GB", { timeZone: routine.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date());
    const task = await createTask(db, SYSTEM, {
      title: `${routine.name} · ${when}`,
      description: `Routine "${routine.name}" (${trigger === "manual" ? "run now" : "scheduled"} run).\n\n${routine.prompt}`,
      assignee: routine.owner_id,
    });
    await db.prepare("UPDATE tasks SET created_by = ? WHERE id = ?").bind(`routine:${routine.id}`, task.id).run();
    // Routine runs start right away, whatever the Orchestrator's per-agent limit.
    const claimed = await startTask(db, SYSTEM, task.id, { maxConcurrent: 99 });
    startAgentOnTask(env, routine.owner_id, claimed.identifier);
    await recordRun(db, routine.id, { status: "started", trigger, task_id: task.id });
    return { status: "started", task: claimed.identifier };
  } catch (err) {
    const reason = err instanceof ServiceError ? err.message : String(err);
    console.error("routine run failed", routine.id, err);
    await recordRun(db, routine.id, { status: "failed", trigger, reason });
    return { status: "failed", reason };
  }
}

export class Scheduler extends DurableObject<Env> {
  // Arm the alarm at the earliest of: next due routine, next daily artifacts retention.
  async reschedule(): Promise<string | null> {
    const row = await this.env.DB_CORE.prepare(
      "SELECT MIN(next_run_at) AS next FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL",
    ).first<{ next: string | null }>();
    const retention = await retentionDue(this.env.DB_CORE);
    const next = Math.min(row?.next ? Date.parse(row.next) : Infinity, retention);
    if (!Number.isFinite(next)) {
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    const at = Math.max(next, Date.now() + 1000);
    await this.ctx.storage.setAlarm(at);
    return new Date(at).toISOString();
  }

  async runNow(routineId: string) {
    const r = await getRoutine(this.env.DB_CORE, routineId);
    const result = await runRoutine(this.env, r, "manual");
    await this.env.DB_CORE.prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").bind(new Date().toISOString(), r.id).run();
    return result;
  }

  async alarm(): Promise<void> {
    const db = this.env.DB_CORE;
    try {
      const { results } = await db
        .prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20")
        .bind(new Date(Date.now() + 1000).toISOString())
        .all<Routine>();
      for (const r of results) {
        const owner = await db.prepare("SELECT status FROM agents WHERE id = ?").bind(r.owner_id).first<{ status: string }>();
        if (owner?.status !== "active") {
          await db.prepare("UPDATE routines SET enabled = 0, next_run_at = NULL WHERE id = ?").bind(r.id).run();
          continue;
        }
        await runRoutine(this.env, r, "schedule");
        await advanceRoutine(db, r);
      }
      if ((await retentionDue(db)) <= Date.now()) await runRetention(this.env);
    } finally {
      await this.reschedule();
    }
  }
}
