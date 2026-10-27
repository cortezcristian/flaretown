// REST for the Projects section (task 019, SPEC-sections-view 2). Rules live in services/projects.

import { HUMAN } from "../services/caller";
import { ServiceError } from "../services/errors";
import { createProject, deleteProject, getProject, listProjects, type ProjectInput, setProjectStatus, updateProject } from "../services/projects";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const methodNotAllowed = () => json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method." }, 405);

async function readInput(request: Request): Promise<ProjectInput> {
  let b: Record<string, unknown> = {};
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    id: str(b.id),
    name: str(b.name),
    description: str(b.description),
    owner_id: b.owner_id === null || b.owner_id === "" ? null : str(b.owner_id),
    repo_url: b.repo_url === null || b.repo_url === "" ? null : str(b.repo_url),
  };
}

export async function handleProjectsApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = pathname.match(/^\/api\/projects(?:\/([a-z0-9-]+)(?:\/(archive|unarchive))?)?\/?$/);
  if (!m) return null;
  const [, id, action] = m;
  const db = env.DB_CORE;
  const method = request.method;
  try {
    if (!id) {
      if (method === "GET") {
        const status = new URL(request.url).searchParams.get("status");
        return json({ projects: await listProjects(db, { status: status === "active" || status === "archived" ? status : "all" }) });
      }
      if (method === "POST") return json(await createProject(db, HUMAN, await readInput(request)), 201);
      return methodNotAllowed();
    }
    if (action) {
      if (method !== "POST") return methodNotAllowed();
      return json(await setProjectStatus(db, HUMAN, id, action === "archive" ? "archived" : "active"));
    }
    if (method === "GET") return json(await getProject(db, id));
    if (method === "PATCH") return json(await updateProject(db, HUMAN, id, await readInput(request)));
    if (method === "DELETE") {
      await deleteProject(db, HUMAN, id);
      return json({ ok: true });
    }
    return methodNotAllowed();
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("projects api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
