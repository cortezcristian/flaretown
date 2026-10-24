// REST for the Artifacts section (SPEC-sections-view section 7). Read-only for the human,
// plus retention controls (pin, days) per task. Repo tokens never reach the browser.

import { ServiceError } from "../services/errors";
import { repoCommitChanges, repoFile, repoLog, repoTree } from "../services/repos";
import { expiresAt, retentionDays } from "../services/retention";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function repoOf(env: Env, agentId: string): Promise<string> {
  const row = await env.DB_CORE.prepare("SELECT artifact_repo FROM agents WHERE id = ?").bind(agentId).first<{ artifact_repo: string | null }>();
  if (!row) throw new ServiceError("not_found", `Agent ${agentId} not found`, "Check the agent id.", 404);
  if (!row.artifact_repo) throw new ServiceError("not_found", "No repo yet", "It's created when the agent first saves something.", 404);
  return row.artifact_repo;
}

type TaskRow = {
  task_id: string;
  identifier: string;
  title: string;
  state: string;
  created_by: string;
  closed_at: string | null;
  artifact_retention_days: number | null;
  artifacts_pinned: number;
  artifacts_deleted_at: string | null;
  files: number;
};

export async function handleArtifactsApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const db = env.DB_CORE;
  try {
    // Retention controls on a task: { pinned?: boolean, days?: number | null }
    const ret = pathname.match(/^\/api\/tasks\/([^/]+)\/retention$/);
    if (ret) {
      if (request.method !== "POST") return json({ error: "Method not allowed", code: "method_not_allowed", hint: "Use POST." }, 405);
      const body = (await request.json().catch(() => ({}))) as { pinned?: boolean; days?: number | null };
      const task = await db.prepare("SELECT id FROM tasks WHERE id = ?1 OR identifier = ?1").bind(ret[1]).first<{ id: string }>();
      if (!task) throw new ServiceError("not_found", `Task ${ret[1]} not found`, "Check the identifier.", 404);
      if (body.days !== undefined && body.days !== null && (!Number.isInteger(body.days) || body.days < 1 || body.days > 3650)) {
        throw new ServiceError("invalid_input", "Retention days out of range", "Use 1 to 3650, or null for the default.");
      }
      if (typeof body.pinned === "boolean") await db.prepare("UPDATE tasks SET artifacts_pinned = ? WHERE id = ?").bind(body.pinned ? 1 : 0, task.id).run();
      if (body.days !== undefined) await db.prepare("UPDATE tasks SET artifact_retention_days = ? WHERE id = ?").bind(body.days, task.id).run();
      return json({ ok: true });
    }

    if (!pathname.startsWith("/api/artifacts")) return null;
    if (request.method !== "GET") return json({ error: "Method not allowed", code: "method_not_allowed", hint: "Use GET." }, 405);
    const url = new URL(request.url);

    if (pathname === "/api/artifacts") {
      const { results } = await db
        .prepare(
          `SELECT a.id, a.name, a.tier, a.status, a.artifact_repo,
             (SELECT COUNT(*) FROM task_artifacts x WHERE x.agent_id = a.id AND x.repo IS NOT NULL) AS reports
           FROM agents a ORDER BY CASE a.tier WHEN 'principal' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END, a.created_at`,
        )
        .all<{ id: string; name: string; tier: string; status: string; artifact_repo: string | null; reports: number }>();
      const repos = await Promise.all(
        results.map(async (a) => {
          if (!a.artifact_repo) return { ...a, last_commit: null };
          const [last] = await repoLog(env, a.artifact_repo, 1).catch(() => []);
          return { ...a, last_commit: last ?? null };
        }),
      );
      return json({ repos });
    }

    const m = pathname.match(/^\/api\/artifacts\/([a-z0-9-]+)\/(tree|file|log|commit|tasks)(?:\/([0-9a-f]{7,64}))?$/);
    if (!m) return json({ error: "Not found", code: "not_found", hint: "Unknown artifacts route." }, 404);
    const [, agentId, what, hash] = m;

    if (what === "tasks") {
      const { results } = await db
        .prepare(
          `SELECT t.id AS task_id, t.identifier, t.title, t.state, t.created_by, t.closed_at, t.artifact_retention_days,
             t.artifacts_pinned, t.artifacts_deleted_at, COUNT(x.id) AS files
           FROM task_artifacts x JOIN tasks t ON t.id = x.task_id
           WHERE x.agent_id = ? AND x.repo IS NOT NULL
           GROUP BY t.id ORDER BY MAX(x.created_at) DESC`,
        )
        .bind(agentId)
        .all<TaskRow>();
      const now = Date.now();
      return json({
        tasks: results.map((t) => {
          const exp = expiresAt(t);
          return {
            ...t,
            retention_days: retentionDays(t),
            expires_at: exp,
            expiring_soon: Boolean(exp && Date.parse(exp) - now < 2 * 86_400_000 && !t.artifacts_deleted_at),
          };
        }),
      });
    }

    const repo = await repoOf(env, agentId!);
    if (what === "tree") return json({ repo, ...(await repoTree(env, repo, url.searchParams.get("path") ?? "")) });
    if (what === "log") return json({ repo, commits: await repoLog(env, repo, 100) });
    if (what === "commit") {
      if (!hash) throw new ServiceError("invalid_input", "Commit hash required", "/api/artifacts/<agent>/commit/<hash>");
      return json({ repo, ...(await repoCommitChanges(env, repo, hash)) });
    }
    // file: raw bytes. HTML is served as text so it never runs on this origin; the UI renders it
    // in a sandboxed iframe (srcdoc).
    const p = url.searchParams.get("path") ?? "";
    const file = await repoFile(env, repo, p);
    if (!file) throw new ServiceError("not_found", `No file ${p}`, "Check the path.", 404);
    const type = /html/i.test(file.type) ? "text/plain; charset=utf-8" : file.type;
    return new Response(file.blob, {
      headers: { "content-type": type, "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("artifacts api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
