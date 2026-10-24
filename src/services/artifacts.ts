// Task deliverables (reports). Agents write them to their own Artifacts repo at
// tasks/<identifier>/<slug>.md (SPEC-agents 5.1.1). Reports saved before task 011 live in R2
// (r2_key) and stay readable. Non-agent callers (human over MCP) still write to R2.

import { type Caller, callerName } from "./caller";
import { ServiceError } from "./errors";
import { commitFiles, ensureAgentRepo, repoFile } from "./repos";
import { getTask } from "./tasks";

export interface TaskArtifact {
  id: string;
  task_id: string;
  agent_id: string;
  title: string;
  r2_key: string;
  repo: string | null;
  path: string | null;
  commit_hash: string | null;
  size: number;
  created_at: string;
}

const MAX_REPORT_BYTES = 512 * 1024;

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}

export async function saveReport(env: Env, caller: Caller, taskRef: string, title: string, markdown: string): Promise<TaskArtifact> {
  const db = env.DB_CORE;
  const task = await getTask(db, taskRef);
  const cleanTitle = (title ?? "").trim() || "Report";
  const body = markdown ?? "";
  const size = new TextEncoder().encode(body).byteLength;
  if (size === 0) throw new ServiceError("invalid_input", "Report is empty", "Write the report in markdown.");
  if (size > MAX_REPORT_BYTES) throw new ServiceError("invalid_input", "Report too large", "Keep reports under 512 KB.");

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  let row: TaskArtifact;

  if (caller.kind === "agent") {
    const agent = await db.prepare("SELECT name, status FROM agents WHERE id = ?").bind(caller.id).first<{ name: string; status: string }>();
    if (agent?.status !== "active") throw new ServiceError("forbidden", "Retired agents can't write", "Its repo is read-only.", 403);
    const repo = await ensureAgentRepo(env, caller.id);
    const filePath = `tasks/${task.identifier}/${slug(cleanTitle)}.md`;
    const commit = await commitFiles(env, repo, [{ path: filePath, content: body }], `${task.identifier}: ${cleanTitle}`, agent.name);
    row = { id, task_id: task.id, agent_id: caller.id, title: cleanTitle, r2_key: "", repo, path: filePath, commit_hash: commit, size, created_at: ts };
  } else {
    const owner = callerName(caller);
    const key = `agents/${owner}/tasks/${task.identifier}/${slug(cleanTitle)}-${id.slice(0, 8)}.md`;
    await env.ARTIFACTS.put(key, body, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    row = { id, task_id: task.id, agent_id: owner, title: cleanTitle, r2_key: key, repo: null, path: null, commit_hash: null, size, created_at: ts };
  }

  await db.batch([
    db
      .prepare(
        "INSERT INTO task_artifacts (id, task_id, agent_id, title, r2_key, repo, path, commit_hash, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(row.id, row.task_id, row.agent_id, row.title, row.r2_key, row.repo, row.path, row.commit_hash, row.size, row.created_at),
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(ts, task.id),
  ]);
  return row;
}

export async function listReports(db: D1Database, taskRef: string): Promise<TaskArtifact[]> {
  const task = await getTask(db, taskRef);
  const { results } = await db
    .prepare("SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at")
    .bind(task.id)
    .all<TaskArtifact>();
  return results;
}

export async function readReport(env: Env, taskRef: string, artifactId: string): Promise<TaskArtifact & { markdown: string }> {
  const db = env.DB_CORE;
  const task = await getTask(db, taskRef);
  const row = await db
    .prepare("SELECT * FROM task_artifacts WHERE task_id = ?1 AND (id = ?2 OR title = ?2)")
    .bind(task.id, artifactId)
    .first<TaskArtifact>();
  if (!row) throw new ServiceError("not_found", `No report ${artifactId} on ${task.identifier}`, "Use reports_list to see the reports.", 404);
  if (row.repo && row.path) {
    // Read the version this report was saved as, so later edits don't change it.
    const file = await repoFile(env, row.repo, row.path, row.commit_hash ?? undefined);
    if (!file) throw new ServiceError("not_found", "Report content missing", "It may have been removed by retention.", 404);
    return { ...row, markdown: await file.blob.text() };
  }
  const obj = await env.ARTIFACTS.get(row.r2_key);
  if (!obj) throw new ServiceError("not_found", "Report content missing", "The R2 object was deleted.", 404);
  return { ...row, markdown: await obj.text() };
}
