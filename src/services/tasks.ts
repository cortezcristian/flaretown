// Task service: the only place task rules live (SPEC-api 1.2, SPEC-agents section 3).
// REST (/api/tasks) and MCP (/mcp/agents) both call these functions.

import { type Caller, callerName, isHumanOrPrincipal, isPrincipal } from "./caller";
import { hasApprovedDecision } from "./decisions";
import { ServiceError } from "./errors";

export type TaskState = "todo" | "in_progress" | "review" | "done" | "cancelled";
export type TaskFilter = "open" | "done" | "all";

const OPEN_STATES: TaskState[] = ["todo", "in_progress", "review"];
const EDITABLE_STATES: TaskState[] = ["todo", "in_progress", "review"];

export interface Criterion {
  position: number;
  text: string;
  checked: boolean;
  checked_by: string | null;
  checked_at: string | null;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface Task {
  id: string;
  identifier: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  state: TaskState;
  priority: number | null;
  assignee: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  // 1 = can't go to review or be closed by an agent without an approved Decision (task 015).
  requires_approval: number;
}

export interface TaskSummary extends Task {
  criteria_total: number;
  criteria_checked: number;
}

export interface SubtaskSummary {
  id: string;
  identifier: string;
  title: string;
  state: TaskState;
  assignee: string | null;
  criteria_total: number;
  criteria_checked: number;
}

export interface TaskDetail extends Task {
  criteria: Criterion[];
  comments: Comment[];
  subtasks: SubtaskSummary[];
}

const now = () => new Date().toISOString();

function forbidden(rule: string, hint: string): ServiceError {
  return new ServiceError("forbidden", `Not allowed: ${rule}`, hint, 403);
}

function requireHumanOrPrincipal(caller: Caller, action: string) {
  if (!isHumanOrPrincipal(caller)) {
    throw forbidden(`only the Principal or the human can ${action}`, "SPEC-agents section 3, Task authority.");
  }
}

// A Lead may review (check criteria, close, send back, cancel) the subtasks of tasks assigned to it.
async function isLeadOfSubtask(db: D1Database, caller: Caller, task: Task): Promise<boolean> {
  if (caller.kind !== "agent" || !task.parent_id) return false;
  const parent = await db.prepare("SELECT assignee FROM tasks WHERE id = ?").bind(task.parent_id).first<{ assignee: string | null }>();
  return parent?.assignee === caller.id;
}

async function requireReviewer(db: D1Database, caller: Caller, task: Task, action: string) {
  if (isHumanOrPrincipal(caller)) return;
  if (await isLeadOfSubtask(db, caller, task)) return;
  throw forbidden(
    `only the Principal, the human, or the Lead of a subtask can ${action}`,
    `${task.identifier} is ${task.parent_id ? "a subtask of another Lead's task" : "a top-level task"}.`,
  );
}

function cleanCriteria(criteria: string[] | undefined): string[] {
  return (criteria ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
}

function titleFrom(description: string): string {
  const first = description.trim().split("\n")[0] ?? "";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

async function findTask(db: D1Database, idOrIdentifier: string): Promise<Task> {
  const task = await db
    .prepare("SELECT * FROM tasks WHERE id = ?1 OR identifier = ?1")
    .bind(idOrIdentifier)
    .first<Task>();
  if (!task) {
    throw new ServiceError("not_found", `Task ${idOrIdentifier} not found`, "Use the task id or its identifier (e.g. FT-3).", 404);
  }
  return task;
}

// ---- create --------------------------------------------------------------------------------

export interface CreateTaskInput {
  description: string;
  title?: string;
  criteria?: string[];
  project_id?: string;
  parent_id?: string;
  priority?: number;
  assignee?: string;
  requires_approval?: boolean;
}

export async function createTask(db: D1Database, caller: Caller, input: CreateTaskInput): Promise<TaskDetail> {
  // "system" opens tasks for routine runs (SPEC-agents 7.2).
  if (caller.kind !== "system") requireHumanOrPrincipal(caller, "open tasks");
  return insertTask(db, caller, input);
}

async function insertTask(db: D1Database, caller: Caller, input: CreateTaskInput): Promise<TaskDetail> {

  const description = (input.description ?? "").trim();
  if (!description) {
    throw new ServiceError("invalid_input", "Description is required", "Describe what the task is about.");
  }

  const criteria = cleanCriteria(input.criteria);
  if (isPrincipal(caller) && criteria.length === 0) {
    throw forbidden(
      "the Principal must give acceptance criteria when opening a task",
      "Add at least one acceptance criterion: a short check of what must be true for the task to be done.",
    );
  }

  const projectId = input.project_id ?? "default";
  const project = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) {
    throw new ServiceError("not_found", `Project ${projectId} not found`, "Use 'default' or an existing project id.", 404);
  }

  if (input.assignee) {
    const agent = await db.prepare("SELECT status FROM agents WHERE id = ?").bind(input.assignee).first<{ status: string }>();
    if (!agent || agent.status !== "active") {
      throw new ServiceError("invalid_input", `Unknown agent ${input.assignee}`, "Assign it to an active agent (see agents_list).");
    }
  }

  let parentId: string | null = null;
  if (input.parent_id) {
    parentId = (await findTask(db, input.parent_id)).id;
  }

  const counter = await db
    .prepare("UPDATE counters SET value = value + 1 WHERE name = 'task' RETURNING value")
    .first<{ value: number }>();
  if (!counter) throw new ServiceError("internal", "Task counter missing", "Run the core migrations.", 500);

  const id = crypto.randomUUID();
  const identifier = `FT-${counter.value}`;
  const title = (input.title ?? "").trim() || titleFrom(description);
  const ts = now();

  await db.batch([
    db
      .prepare(
        `INSERT INTO tasks (id, identifier, project_id, parent_id, title, description, priority, assignee, created_by, created_at, updated_at, requires_approval)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        identifier,
        projectId,
        parentId,
        title,
        description,
        input.priority ?? null,
        input.assignee ?? null,
        callerName(caller),
        ts,
        ts,
        input.requires_approval ? 1 : 0,
      ),
    ...criteria.map((text, i) =>
      db.prepare("INSERT INTO task_criteria (task_id, position, text) VALUES (?, ?, ?)").bind(id, i + 1, text),
    ),
  ]);

  return getTask(db, id);
}

// ---- subtasks (Lead → Operators, SPEC-agents section 3) ------------------------------------

export interface CreateSubtaskInput {
  parent: string;
  description: string;
  title?: string;
  criteria: string[];
  assignee: string;
}

export async function createSubtask(db: D1Database, caller: Caller, input: CreateSubtaskInput): Promise<TaskDetail> {
  if (caller.kind !== "agent") {
    throw forbidden("subtasks are created by the Lead of the parent task", "Use tasks_create with parent_id as the human or Principal.");
  }
  const parent = await getTask(db, input.parent);
  if (parent.assignee !== caller.id) {
    throw forbidden("a Lead can only split tasks assigned to it", `${parent.identifier} is assigned to ${parent.assignee ?? "nobody"}.`);
  }
  if (parent.parent_id) {
    throw forbidden("subtasks can't have subtasks", `${parent.identifier} is already a subtask.`);
  }
  if (!EDITABLE_STATES.includes(parent.state)) {
    throw new ServiceError("invalid_state", `${parent.identifier} is ${parent.state}`, "Only open tasks can get subtasks.", 409);
  }
  const op = await db
    .prepare("SELECT id, tier, parent_id, status FROM agents WHERE id = ?1 OR name = ?1")
    .bind(input.assignee)
    .first<{ id: string; tier: string; parent_id: string | null; status: string }>();
  if (!op || op.tier !== "operator" || op.parent_id !== caller.id || op.status !== "active") {
    throw forbidden("subtasks go to active Operators under you", "See agents_list, or create one with agents_create.");
  }
  const criteria = cleanCriteria(input.criteria);
  if (criteria.length === 0) {
    throw forbidden("a subtask needs at least one acceptance criterion of its own", "Add what must be true for this piece of work.");
  }
  const inherited = parent.criteria.length
    ? `\n\nParent ${parent.identifier} acceptance criteria (context):\n${parent.criteria.map((c) => `- ${c.text}`).join("\n")}`
    : "";
  // Created as the Lead, so it bypasses the "only Principal or human open tasks" rule on purpose.
  return insertTask(db, caller, {
    description: `${input.description.trim()}${inherited}`,
    title: input.title,
    criteria,
    project_id: parent.project_id,
    parent_id: parent.id,
    assignee: op.id,
  });
}

// Open subtasks left on a parent (used to tell the Lead when all are done).
export async function openSubtaskCount(db: D1Database, parentId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND state NOT IN ('done', 'cancelled')")
    .bind(parentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- read ----------------------------------------------------------------------------------

export async function getTask(db: D1Database, idOrIdentifier: string): Promise<TaskDetail> {
  const task = await findTask(db, idOrIdentifier);
  const [criteria, comments, subtasks] = await db.batch([
    db.prepare("SELECT position, text, checked, checked_by, checked_at FROM task_criteria WHERE task_id = ? ORDER BY position").bind(task.id),
    db.prepare("SELECT id, author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at").bind(task.id),
    db
      .prepare(
        `SELECT t.id, t.identifier, t.title, t.state, t.assignee,
           (SELECT COUNT(*) FROM task_criteria c WHERE c.task_id = t.id) AS criteria_total,
           (SELECT COUNT(*) FROM task_criteria c WHERE c.task_id = t.id AND c.checked = 1) AS criteria_checked
         FROM tasks t WHERE t.parent_id = ? ORDER BY t.created_at`,
      )
      .bind(task.id),
  ]);
  return {
    ...task,
    subtasks: (subtasks?.results ?? []) as unknown as SubtaskSummary[],
    criteria: ((criteria?.results ?? []) as Array<Criterion & { checked: number }>).map((c) => ({ ...c, checked: Boolean(c.checked) })),
    comments: (comments?.results ?? []) as unknown as Comment[],
  };
}

export interface ListTasksInput {
  filter?: TaskFilter;
  project_id?: string;
  assignee?: string;
}

export interface ListTasksResult {
  tasks: TaskSummary[];
  counts: { open: number; done: number; all: number };
}

export async function listTasks(db: D1Database, input: ListTasksInput = {}): Promise<ListTasksResult> {
  const filter = input.filter ?? "open";
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.project_id) {
    where.push("t.project_id = ?");
    params.push(input.project_id);
  }
  if (input.assignee) {
    where.push("t.assignee = ?");
    params.push(input.assignee);
  }
  // Counters use the project/assignee filters only, not the Open/Done tab.
  const projectWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const baseParams = [...params];

  if (filter === "open") where.push(`t.state IN (${OPEN_STATES.map(() => "?").join(", ")})`), params.push(...OPEN_STATES);
  if (filter === "done") where.push("t.state = 'done'");
  const listWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const listSql = `
    SELECT t.*,
      (SELECT COUNT(*) FROM task_criteria c WHERE c.task_id = t.id) AS criteria_total,
      (SELECT COUNT(*) FROM task_criteria c WHERE c.task_id = t.id AND c.checked = 1) AS criteria_checked
    FROM tasks t ${listWhere}
    ORDER BY t.updated_at DESC
    LIMIT 200`;

  const countSql = `
    SELECT
      SUM(CASE WHEN t.state IN ('todo', 'in_progress', 'review') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN t.state = 'done' THEN 1 ELSE 0 END) AS done,
      COUNT(*) AS all_count
    FROM tasks t ${projectWhere}`;

  const [list, counts] = await db.batch([
    db.prepare(listSql).bind(...params),
    db.prepare(countSql).bind(...baseParams),
  ]);

  const c = (counts?.results?.[0] ?? {}) as { open?: number | null; done?: number | null; all_count?: number | null };
  return {
    tasks: (list?.results ?? []) as unknown as TaskSummary[],
    counts: { open: c.open ?? 0, done: c.done ?? 0, all: c.all_count ?? 0 },
  };
}

// ---- update --------------------------------------------------------------------------------

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: number | null;
  state?: TaskState;
  assignee?: string | null;
  requires_approval?: boolean;
}

// Agents can't move a task that requires approval forward without an approved Decision.
async function requireApproval(db: D1Database, caller: Caller, task: Task, action: string) {
  if (caller.kind !== "agent" || !task.requires_approval) return;
  if (await hasApprovedDecision(db, task.id)) return;
  throw forbidden(
    `${task.identifier} requires an approved Decision before it can ${action}`,
    `Request one with decisions_request (task: ${task.identifier}) and wait for it to be approved.`,
  );
}

export async function updateTask(db: D1Database, caller: Caller, idOrIdentifier: string, input: UpdateTaskInput): Promise<TaskDetail> {
  const task = await findTask(db, idOrIdentifier);
  if (!EDITABLE_STATES.includes(task.state)) {
    throw new ServiceError("invalid_state", `${task.identifier} is ${task.state}`, "Closed or cancelled tasks can't be edited.", 409);
  }
  if (input.state === "done" || input.state === "cancelled") {
    throw new ServiceError("invalid_state", `Use close or cancel to move a task to ${input.state}`, "tasks_close / tasks_cancel.");
  }
  if (input.state && !EDITABLE_STATES.includes(input.state)) {
    throw new ServiceError("invalid_input", `Unknown state ${input.state}`, `Use one of ${EDITABLE_STATES.join(", ")}.`);
  }

  if (input.state === "review") {
    const { n } = (await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND state NOT IN ('done', 'cancelled')")
      .bind(task.id)
      .first<{ n: number }>())!;
    if (n > 0) {
      throw new ServiceError("invalid_state", `${task.identifier} has ${n} open subtask(s)`, "Finish its subtasks before moving it to review.", 409);
    }
    await requireApproval(db, caller, task, "go to review");
  }

  // Leads and Operators can only touch their own task: move it between in_progress and review,
  // and edit its text. Assignment and priority stay with the Principal and the human.
  if (!isHumanOrPrincipal(caller)) {
    if (caller.kind !== "agent" || task.assignee !== caller.id) {
      throw forbidden("agents can only update tasks assigned to them", `${task.identifier} is assigned to ${task.assignee ?? "nobody"}.`);
    }
    if (input.assignee !== undefined || input.priority !== undefined || input.requires_approval !== undefined) {
      throw forbidden("only the Principal or the human can reassign, reprioritize or change approval", "Comment on the task instead.");
    }
    if (input.state === "todo") {
      throw forbidden("agents can't put their task back in the queue", "Use in_progress or review.");
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.title !== undefined) sets.push("title = ?"), params.push(input.title.trim() || task.title);
  if (input.description !== undefined) sets.push("description = ?"), params.push(input.description);
  if (input.priority !== undefined) sets.push("priority = ?"), params.push(input.priority);
  if (input.state !== undefined) sets.push("state = ?"), params.push(input.state);
  if (input.assignee !== undefined) sets.push("assignee = ?"), params.push(input.assignee);
  if (input.requires_approval !== undefined) sets.push("requires_approval = ?"), params.push(input.requires_approval ? 1 : 0);
  if (sets.length === 0) return getTask(db, task.id);

  sets.push("updated_at = ?");
  params.push(now(), task.id);
  await db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  return getTask(db, task.id);
}

// ---- comments ------------------------------------------------------------------------------

export async function commentTask(db: D1Database, caller: Caller, idOrIdentifier: string, body: string): Promise<TaskDetail> {
  const task = await findTask(db, idOrIdentifier);
  const text = (body ?? "").trim();
  if (!text) throw new ServiceError("invalid_input", "Comment body is required", "Write something.");
  const ts = now();
  await db.batch([
    db.prepare("INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), task.id, callerName(caller), text, ts),
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(ts, task.id),
  ]);
  return getTask(db, task.id);
}

// ---- acceptance criteria -------------------------------------------------------------------

export async function checkCriterion(
  db: D1Database,
  caller: Caller,
  idOrIdentifier: string,
  position: number,
  checked: boolean,
): Promise<TaskDetail> {
  const task = await findTask(db, idOrIdentifier);
  await requireReviewer(db, caller, task, "check acceptance criteria");
  const ts = now();
  const result = await db
    .prepare("UPDATE task_criteria SET checked = ?, checked_by = ?, checked_at = ? WHERE task_id = ? AND position = ?")
    .bind(checked ? 1 : 0, checked ? callerName(caller) : null, checked ? ts : null, task.id, position)
    .run();
  if (!result.meta.changes) {
    throw new ServiceError("not_found", `${task.identifier} has no criterion ${position}`, "Positions start at 1.", 404);
  }
  await db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(ts, task.id).run();
  return getTask(db, task.id);
}

// ---- run now -------------------------------------------------------------------------------

// Claims a todo task so its assignee starts working on it: Run now (human / Principal) or the
// Orchestrator (system). Atomic: only one caller can move it from todo to in_progress.
// Unassigned tasks go to the Principal.
export async function startTask(
  db: D1Database,
  caller: Caller,
  idOrIdentifier: string,
  opts: { maxConcurrent?: number } = {},
): Promise<TaskDetail> {
  if (caller.kind !== "system") requireHumanOrPrincipal(caller, "run tasks now");
  const task = await findTask(db, idOrIdentifier);
  const assignee = task.assignee ?? "principal";

  const agent = await db.prepare("SELECT status FROM agents WHERE id = ?").bind(assignee).first<{ status: string }>();
  if (!agent || agent.status !== "active") {
    throw new ServiceError("invalid_state", `${task.identifier} is assigned to ${assignee}, which is not an active agent`, "Reassign it first.", 409);
  }

  const max = opts.maxConcurrent ?? 1;
  const { n } = (await db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE assignee = ? AND state = 'in_progress'")
    .bind(assignee)
    .first<{ n: number }>())!;
  if (n >= max) {
    throw new ServiceError("busy", `${assignee} is busy`, `It already has ${n} task(s) in progress. The task stays queued.`, 409);
  }

  const claimed = await db
    .prepare("UPDATE tasks SET state = 'in_progress', assignee = ?, updated_at = ? WHERE id = ? AND state = 'todo' RETURNING id")
    .bind(assignee, now(), task.id)
    .first();
  if (!claimed) {
    throw new ServiceError("invalid_state", `${task.identifier} is ${task.state}`, "Only tasks in todo can be started.", 409);
  }
  return getTask(db, task.id);
}

// ---- close / send back / cancel ------------------------------------------------------------

export async function closeTask(db: D1Database, caller: Caller, idOrIdentifier: string): Promise<TaskDetail> {
  const task = await getTask(db, idOrIdentifier);
  await requireReviewer(db, caller, task, "close tasks");
  if (!EDITABLE_STATES.includes(task.state)) {
    throw new ServiceError("invalid_state", `${task.identifier} is already ${task.state}`, "Nothing to close.", 409);
  }

  const openSubtasks = await db
    .prepare(`SELECT identifier FROM tasks WHERE parent_id = ? AND state NOT IN ('done', 'cancelled')`)
    .bind(task.id)
    .all<{ identifier: string }>();
  if (openSubtasks.results.length > 0) {
    throw new ServiceError(
      "invalid_state",
      `${task.identifier} has open subtasks`,
      `Close or cancel first: ${openSubtasks.results.map((s) => s.identifier).join(", ")}.`,
      409,
    );
  }

  await requireApproval(db, caller, task, "be closed");

  // Agents (Principal, or a Lead closing a subtask) close only after every criterion is checked.
  // The human can close any time.
  if (caller.kind === "agent") {
    const unchecked = task.criteria.filter((c) => !c.checked);
    if (unchecked.length > 0) {
      throw forbidden(
        "an agent can't close a task with unchecked acceptance criteria",
        `Check them first or send the task back. Unchecked: ${unchecked.map((c) => `${c.position}. ${c.text}`).join("; ")}.`,
      );
    }
  }

  const ts = now();
  await db.prepare("UPDATE tasks SET state = 'done', closed_at = ?, updated_at = ? WHERE id = ?").bind(ts, ts, task.id).run();
  return getTask(db, task.id);
}

export async function sendBackTask(db: D1Database, caller: Caller, idOrIdentifier: string, reason: string): Promise<TaskDetail> {
  const task = await findTask(db, idOrIdentifier);
  await requireReviewer(db, caller, task, "send tasks back");
  if (task.state !== "review") {
    throw new ServiceError("invalid_state", `${task.identifier} is ${task.state}, not in review`, "Only tasks in review can be sent back.", 409);
  }
  const text = (reason ?? "").trim();
  if (!text) throw new ServiceError("invalid_input", "A reason is required", "Say what is missing or which criteria failed.");
  const ts = now();
  await db.batch([
    db.prepare("UPDATE tasks SET state = 'in_progress', updated_at = ? WHERE id = ?").bind(ts, task.id),
    db.prepare("INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), task.id, callerName(caller), `Sent back: ${text}`, ts),
  ]);
  return getTask(db, task.id);
}

export async function cancelTask(db: D1Database, caller: Caller, idOrIdentifier: string): Promise<TaskDetail> {
  const task = await findTask(db, idOrIdentifier);
  await requireReviewer(db, caller, task, "cancel tasks");
  if (!EDITABLE_STATES.includes(task.state)) {
    throw new ServiceError("invalid_state", `${task.identifier} is already ${task.state}`, "Nothing to cancel.", 409);
  }
  const ts = now();
  await db.prepare("UPDATE tasks SET state = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?").bind(ts, ts, task.id).run();
  return getTask(db, task.id);
}
