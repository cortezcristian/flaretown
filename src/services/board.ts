// Kanban board data (SPEC-kanban): tasks of the last N days grouped by column.

export type Column = "todo" | "in_progress" | "review" | "done";

export interface Card {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: number | null;
  project_id: string;
  assignee: string | null;
  parent_id: string | null;
  created_by: string;
  updated_at: string;
  state_changed_at: string | null;
  criteria_total: number;
  criteria_checked: number;
  subtasks_total: number;
  subtasks_done: number;
  sent_back: number;
  working: number;
}

export interface BoardInput {
  days?: number;
  project_id?: string;
  // An agent id; for a Lead, team=true also includes its Operators.
  agent?: string;
  team?: boolean;
  mine?: boolean;
  q?: string;
}

export interface Board {
  since: string;
  columns: Record<Column, Card[]>;
  older_open: number;
}

export async function getBoard(db: D1Database, input: BoardInput = {}): Promise<Board> {
  const days = Math.min(Math.max(input.days ?? 7, 1), 30);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const where: string[] = ["t.state IN ('todo', 'in_progress', 'review', 'done')"];
  const params: unknown[] = [];
  if (input.project_id) where.push("t.project_id = ?"), params.push(input.project_id);
  if (input.agent) {
    if (input.team) {
      where.push("(t.assignee = ? OR t.assignee IN (SELECT id FROM agents WHERE parent_id = ?))");
      params.push(input.agent, input.agent);
    } else {
      where.push("t.assignee = ?");
      params.push(input.agent);
    }
  }
  if (input.mine) where.push("t.created_by = 'human'");
  if (input.q) {
    where.push("(t.identifier LIKE ? OR t.title LIKE ?)");
    const like = `%${input.q.slice(0, 30)}%`;
    params.push(like, like);
  }
  const filters = where.join(" AND ");

  const [cards, older] = await db.batch([
    db
      .prepare(
        `SELECT t.id, t.identifier, t.title, t.state, t.priority, t.project_id, t.assignee, t.parent_id, t.created_by,
           t.updated_at, t.state_changed_at,
           (SELECT COUNT(*) FROM task_criteria c WHERE c.task_id = t.id) AS criteria_total,
           (SELECT COUNT(*) FROM task_criteria c WHERE c.task_id = t.id AND c.checked = 1) AS criteria_checked,
           (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtasks_total,
           (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.state = 'done') AS subtasks_done,
           (t.state = 'in_progress' AND EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.body LIKE 'Sent back:%'
              AND c.created_at >= COALESCE(t.state_changed_at, t.updated_at))) AS sent_back,
           (t.state = 'in_progress') AS working
         FROM tasks t
         WHERE ${filters}
           AND (CASE WHEN t.state = 'done' THEN t.closed_at >= ? ELSE (t.created_at >= ? OR t.updated_at >= ?) END)
         ORDER BY COALESCE(t.state_changed_at, t.updated_at) DESC
         LIMIT 300`,
      )
      .bind(...params, since, since, since),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t
         WHERE ${filters} AND t.state IN ('todo', 'in_progress', 'review') AND t.created_at < ? AND t.updated_at < ?`,
      )
      .bind(...params, since, since),
  ]);

  const columns: Record<Column, Card[]> = { todo: [], in_progress: [], review: [], done: [] };
  for (const c of (cards?.results ?? []) as unknown as Card[]) columns[c.state as Column]?.push(c);
  const n = ((older?.results?.[0] ?? {}) as { n?: number }).n ?? 0;
  return { since, columns, older_open: n };
}
