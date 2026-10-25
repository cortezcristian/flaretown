// Orchestrator: the only thing that dispatches queued tasks (SPEC-orchestrator section 6).
// One Durable Object instance ("default"). Wakes on an alarm every poll interval (setting) and
// when poked (task created / assigned). Nothing runs while it is disabled (kill switch).

import { DurableObject } from "cloudflare:workers";
import { startAgentOnTask } from "./runtime";
import { SYSTEM } from "./services/caller";
import { ServiceError } from "./services/errors";
import { getOrchestratorSettings } from "./services/settings";
import { commentTask, startTask } from "./services/tasks";

export interface TickResult {
  at: string;
  reason: "alarm" | "poke" | "manual";
  enabled: boolean;
  dispatched: string[];
  skipped_busy: string[];
  stalled: string[];
}

export interface OrchestratorStatus {
  last_tick: TickResult | null;
  next_tick_at: string | null;
  running: Array<{ identifier: string; title: string; assignee: string; updated_at: string }>;
}

export class Orchestrator extends DurableObject<Env> {
  async poke(): Promise<TickResult> {
    return this.tick("poke");
  }

  async tickNow(): Promise<TickResult> {
    return this.tick("manual");
  }

  // Call after settings change: schedule (or cancel) the next alarm.
  async reschedule(): Promise<string | null> {
    const settings = await getOrchestratorSettings(this.env.DB_CORE);
    if (!settings.enabled) {
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    const next = Date.now() + settings.poll_interval_s * 1000;
    await this.ctx.storage.setAlarm(next);
    return new Date(next).toISOString();
  }

  async alarm(): Promise<void> {
    try {
      await this.tick("alarm");
    } finally {
      await this.reschedule();
    }
  }

  async status(): Promise<OrchestratorStatus> {
    const alarm = await this.ctx.storage.getAlarm();
    const { results } = await this.env.DB_CORE.prepare(
      "SELECT identifier, title, assignee, updated_at FROM tasks WHERE state = 'in_progress' ORDER BY updated_at",
    ).all<{ identifier: string; title: string; assignee: string; updated_at: string }>();
    return {
      last_tick: (await this.ctx.storage.get<TickResult>("last_tick")) ?? null,
      next_tick_at: alarm ? new Date(alarm).toISOString() : null,
      running: results,
    };
  }

  private async tick(reason: TickResult["reason"]): Promise<TickResult> {
    const db = this.env.DB_CORE;
    const settings = await getOrchestratorSettings(db);
    const result: TickResult = { at: new Date().toISOString(), reason, enabled: settings.enabled, dispatched: [], skipped_busy: [], stalled: [] };

    if (settings.enabled) {
      // 1. Stall detection: in progress with no activity for the stall timeout. Comment once, leave it for the human.
      const cutoff = new Date(Date.now() - settings.stall_timeout_min * 60_000).toISOString();
      const stalled = await db
        .prepare(
          `SELECT t.identifier FROM tasks t
           WHERE t.state = 'in_progress' AND t.updated_at < ?
             -- A parent waiting on its Operators' subtasks is not stalled.
             AND NOT EXISTS (SELECT 1 FROM tasks s WHERE s.parent_id = t.id AND s.state NOT IN ('done', 'cancelled'))
             AND NOT EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.author = 'orchestrator' AND c.body LIKE 'Stalled%' AND c.created_at >= t.updated_at)`,
        )
        .bind(cutoff)
        .all<{ identifier: string }>();
      for (const { identifier } of stalled.results) {
        await commentTask(db, SYSTEM, identifier, `Stalled: no activity for ${settings.stall_timeout_min} min. Check it or send it back.`);
        result.stalled.push(identifier);
      }

      // 2. Dispatch queued tasks assigned to active agents, oldest first.
      const queued = await db
        .prepare(
          `SELECT t.identifier, COALESCE(t.assignee, 'principal') AS assignee FROM tasks t
           JOIN agents a ON a.id = COALESCE(t.assignee, 'principal') AND a.status = 'active'
           WHERE t.state = 'todo'
           ORDER BY COALESCE(t.priority, 99), t.created_at
           LIMIT 20`,
        )
        .all<{ identifier: string; assignee: string }>();
      for (const task of queued.results) {
        try {
          const claimed = await startTask(db, SYSTEM, task.identifier, { maxConcurrent: settings.max_concurrent_per_agent });
          startAgentOnTask(this.env, claimed.assignee ?? "principal", claimed.identifier);
          result.dispatched.push(claimed.identifier);
        } catch (err) {
          if (err instanceof ServiceError && err.code === "busy") result.skipped_busy.push(task.identifier);
          else if (!(err instanceof ServiceError)) console.error("dispatch failed", task.identifier, err);
        }
      }
    }

    await this.ctx.storage.put("last_tick", result);
    // Make sure an alarm is pending while enabled (first enable, or after a deploy).
    if (settings.enabled && !(await this.ctx.storage.getAlarm())) await this.reschedule();
    return result;
  }
}
