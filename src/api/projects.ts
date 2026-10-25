// REST for projects under /api/projects (read-only for now).

export async function handleProjectsApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/projects") return null;
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed", code: "method_not_allowed", hint: "Use GET." }, { status: 405 });
  }
  const { results } = await env.DB_CORE.prepare("SELECT id, name, repo_url, created_at FROM projects ORDER BY name").all();
  return Response.json({ projects: results });
}
