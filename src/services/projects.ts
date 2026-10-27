// Projects (task 019, SPEC-sections-view 2): group tasks by product, client or stream of work.
// The only place project rules live. Default always exists: rename and describe it, never archive or delete.

import { type Caller, callerName, isHumanOrPrincipal } from "./caller";
import { ServiceError } from "./errors";

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  name: string;
  description: string;
  repo_url: string | null;
  owner_id: string | null;
  owner_name: string | null;
  status: ProjectStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Counts
  open: number; // todo + in_progress + review
  in_review: number;
  done_7d: number;
  total: number;
}

export const DEFAULT_PROJECT = "default";
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

const now = () => new Date().toISOString();

function forbidden(rule: string, hint = ""): ServiceError {
  return new ServiceError("forbidden", `Not allowed: ${rule}`, hint, 403);
}

function requireManager(caller: Caller) {
  if (!isHumanOrPrincipal(caller)) throw forbidden("only the human or the Principal manages projects", "Ask the Principal.");
}

const SELECT = `
  SELECT p.*, a.name AS owner_name,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.state IN ('todo', 'in_progress', 'review')) AS open,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.state = 'review') AS in_review,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.state = 'done' AND t.updated_at >= ?) AS done_7d,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total
  FROM projects p LEFT JOIN agents a ON a.id = p.owner_id`;

const weekAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

type Row = Omit<Project, "updated_at"> & { updated_at: string | null };
const toProject = (r: Row): Project => ({ ...r, description: r.description ?? "", updated_at: r.updated_at ?? r.created_at });

export async function listProjects(db: D1Database, opts: { status?: ProjectStatus | "all" } = {}): Promise<Project[]> {
  const status = opts.status ?? "all";
  const where = status === "all" ? "" : "WHERE p.status = ?";
  const stmt = db.prepare(`${SELECT} ${where} ORDER BY p.id = 'default' DESC, p.name COLLATE NOCASE`);
  const { results } = await (status === "all" ? stmt.bind(weekAgo()) : stmt.bind(weekAgo(), status)).all<Row>();
  return results.map(toProject);
}

export async function getProject(db: D1Database, id: string): Promise<Project> {
  const row = await db.prepare(`${SELECT} WHERE p.id = ?`).bind(weekAgo(), id).first<Row>();
  if (!row) throw new ServiceError("not_found", `Project ${id} not found`, "See projects_list for the ids.", 404);
  return toProject(row);
}

// For task creation: the project must exist and be active.
export async function requireActiveProject(db: D1Database, id: string): Promise<void> {
  const row = await db.prepare("SELECT status FROM projects WHERE id = ?").bind(id).first<{ status: string }>();
  if (!row) throw new ServiceError("not_found", `Project ${id} not found`, "Use 'default' or an existing project id (projects_list).", 404);
  if (row.status === "archived") throw new ServiceError("invalid_state", `Project ${id} is archived`, "Unarchive it first, or use another project.", 409);
}

export function slugify(name: string): string {
  const id = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return /^[a-z]/.test(id) ? id : `p-${id}`.slice(0, 32).replace(/-+$/, "");
}

async function checkOwner(db: D1Database, ownerId: string | null | undefined): Promise<string | null> {
  if (!ownerId) return null;
  const agent = await db.prepare("SELECT tier, status FROM agents WHERE id = ?").bind(ownerId).first<{ tier: string; status: string }>();
  if (!agent || agent.status !== "active") throw new ServiceError("invalid_input", `Unknown agent ${ownerId}`, "Pick an active Lead (agents_list).");
  if (agent.tier !== "lead") throw new ServiceError("invalid_input", `${ownerId} is not a Lead`, "A project's owner is a Lead.");
  return ownerId;
}

export interface ProjectInput {
  id?: string;
  name?: string;
  description?: string;
  owner_id?: string | null;
  repo_url?: string | null;
}

function cleanRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:") throw new Error();
    return u.href;
  } catch {
    throw new ServiceError("invalid_input", "Repository URL is not valid", "Use an https:// URL, or leave it empty.");
  }
}

export async function createProject(db: D1Database, caller: Caller, input: ProjectInput): Promise<Project> {
  requireManager(caller);
  const name = (input.name ?? "").trim();
  if (!name) throw new ServiceError("invalid_input", "Name is required", "e.g. Website relaunch.");
  if (name.length > 80) throw new ServiceError("invalid_input", "Name is too long", "Max 80 characters.");
  const id = (input.id ?? "").trim() || slugify(name);
  if (!ID_RE.test(id)) throw new ServiceError("invalid_input", `Invalid id ${id}`, "Lowercase letters, digits and dashes, starting with a letter (max 32).");
  const taken = await db.prepare("SELECT id FROM projects WHERE id = ? OR name = ? COLLATE NOCASE").bind(id, name).first();
  if (taken) throw new ServiceError("conflict", `A project named ${name} (or with id ${id}) already exists`, "Pick another name.", 409);
  const owner = await checkOwner(db, input.owner_id);
  const ts = now();
  await db
    .prepare(
      "INSERT INTO projects (id, name, description, repo_url, owner_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)",
    )
    .bind(id, name, (input.description ?? "").trim(), cleanRepo(input.repo_url), owner, callerName(caller), ts, ts)
    .run();
  return getProject(db, id);
}

export async function updateProject(db: D1Database, caller: Caller, id: string, input: ProjectInput): Promise<Project> {
  requireManager(caller);
  const current = await getProject(db, id);
  const name = input.name !== undefined ? input.name.trim() : current.name;
  if (!name) throw new ServiceError("invalid_input", "Name is required", "");
  if (name.toLowerCase() !== current.name.toLowerCase()) {
    const taken = await db.prepare("SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND id != ?").bind(name, id).first();
    if (taken) throw new ServiceError("conflict", `A project named ${name} already exists`, "Pick another name.", 409);
  }
  const owner = input.owner_id !== undefined ? await checkOwner(db, input.owner_id) : current.owner_id;
  const description = input.description !== undefined ? input.description.trim() : current.description;
  const repo = input.repo_url !== undefined ? cleanRepo(input.repo_url) : current.repo_url;
  await db
    .prepare("UPDATE projects SET name = ?, description = ?, owner_id = ?, repo_url = ?, updated_at = ? WHERE id = ?")
    .bind(name, description, owner, repo, now(), id)
    .run();
  return getProject(db, id);
}

export async function setProjectStatus(db: D1Database, caller: Caller, id: string, status: ProjectStatus): Promise<Project> {
  requireManager(caller);
  if (id === DEFAULT_PROJECT && status === "archived") throw forbidden("the Default project can't be archived");
  await getProject(db, id);
  await db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").bind(status, now(), id).run();
  return getProject(db, id);
}

export async function deleteProject(db: D1Database, caller: Caller, id: string): Promise<void> {
  requireManager(caller);
  if (id === DEFAULT_PROJECT) throw forbidden("the Default project can't be deleted");
  const project = await getProject(db, id);
  if (project.total > 0) {
    throw new ServiceError("invalid_state", `${project.name} has ${project.total} task(s)`, "Move its tasks to another project or archive it instead.", 409);
  }
  await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
}

// Move a task and all its subtasks (any depth) to another active project.
export async function moveTaskToProject(db: D1Database, taskId: string, projectId: string): Promise<number> {
  await requireActiveProject(db, projectId);
  const res = await db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
       UPDATE tasks SET project_id = ?, updated_at = ? WHERE id IN (SELECT id FROM tree)`,
    )
    .bind(taskId, projectId, now())
    .run();
  return res.meta.changes ?? 0;
}

// Overview card: active projects and how many have open work.
export async function projectCounts(db: D1Database): Promise<{ active: number; with_open_work: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM projects WHERE status = 'active') AS active,
         (SELECT COUNT(DISTINCT project_id) FROM tasks WHERE state IN ('todo', 'in_progress', 'review')) AS with_open_work`,
    )
    .first<{ active: number; with_open_work: number }>();
  return { active: row?.active ?? 0, with_open_work: row?.with_open_work ?? 0 };
}
