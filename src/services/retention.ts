// Artifacts retention per task (SPEC-agents 5.1.1). Retention counts from the task's close date,
// so open work never expires. Pinned task folders never expire.
//   routine runs: 14 days · regular tasks: 30 days · cancelled: 7 days · task override wins.
// v1 deletes expired tasks/<identifier>/ folders with a commit; git history keeps them
// (squash is in TECH_DEBT.md).

import { commitFiles } from "./repos";

export const RETENTION_DAYS = { routine: 14, regular: 30, cancelled: 7 } as const;
const DAY = 86_400_000;

export function retentionDays(task: { created_by: string; state: string; artifact_retention_days: number | null }): number {
  if (task.artifact_retention_days) return task.artifact_retention_days;
  if (task.state === "cancelled") return RETENTION_DAYS.cancelled;
  if (task.created_by.startsWith("routine:")) return RETENTION_DAYS.routine;
  return RETENTION_DAYS.regular;
}

export function expiresAt(task: {
  created_by: string;
  state: string;
  closed_at: string | null;
  artifact_retention_days: number | null;
  artifacts_pinned: number;
}): string | null {
  if (task.artifacts_pinned || !task.closed_at) return null;
  return new Date(Date.parse(task.closed_at) + retentionDays(task) * DAY).toISOString();
}

type Row = {
  task_id: string;
  identifier: string;
  repo: string;
  created_by: string;
  state: string;
  closed_at: string | null;
  artifact_retention_days: number | null;
  artifacts_pinned: number;
};

// Daily: delete expired task folders, one commit per repo. Returns what was removed.
export async function runRetention(env: Env): Promise<Record<string, string[]>> {
  const db = env.DB_CORE;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT t.id AS task_id, t.identifier, a.repo, t.created_by, t.state, t.closed_at, t.artifact_retention_days, t.artifacts_pinned
       FROM task_artifacts a JOIN tasks t ON t.id = a.task_id
       WHERE a.repo IS NOT NULL AND t.closed_at IS NOT NULL AND t.artifacts_deleted_at IS NULL AND t.artifacts_pinned = 0`,
    )
    .all<Row>();
  const now = Date.now();
  const byRepo = new Map<string, Row[]>();
  for (const r of results) {
    const exp = expiresAt(r);
    if (exp && Date.parse(exp) <= now) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  }
  const removed: Record<string, string[]> = {};
  for (const [repo, rows] of byRepo) {
    try {
      await commitFiles(
        env,
        repo,
        rows.map((r) => ({ path: `tasks/${r.identifier}`, content: null })),
        `retention: removed ${rows.length} task folder(s): ${rows.map((r) => r.identifier).join(", ")}`,
        "Flaretown retention",
      );
      const ts = new Date().toISOString();
      await db.batch(rows.map((r) => db.prepare("UPDATE tasks SET artifacts_deleted_at = ? WHERE id = ?").bind(ts, r.task_id)));
      removed[repo] = rows.map((r) => r.identifier);
    } catch (err) {
      console.error("retention failed", repo, err);
    }
  }
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'artifacts_last_retention_at'").bind(new Date().toISOString()).run();
  return removed;
}

export async function retentionDue(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'artifacts_last_retention_at'").first<{ value: string }>();
  const last = row?.value ? Date.parse(row.value) : 0;
  return last + DAY;
}
