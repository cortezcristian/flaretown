// REST for the Skills section (task 017, SPEC-skills). Installing, updating and deleting skills
// is human only: skills are instructions agents follow.

import { HUMAN } from "../services/caller";
import { ServiceError } from "../services/errors";
import {
  deleteSkill,
  getSkill,
  getSkillsSettings,
  installSkill,
  listSkills,
  previewFromGitHub,
  previewFromPaste,
  previewFromZip,
  previewUpdate,
  readSkillFile,
  setAllAgents,
  setSkillsSettings,
  suggestedSkills,
} from "../services/skills";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const methodNotAllowed = () => json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method." }, 405);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function handleSkillsApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/skills")) return null;
  const db = env.DB_CORE;
  const method = request.method;
  try {
    if (pathname === "/api/skills") {
      if (method === "GET") return json({ skills: await listSkills(db), settings: await getSkillsSettings(db) });
      if (method === "POST") {
        const b = await readJson(request);
        if (typeof b.preview_id !== "string") throw new ServiceError("invalid_input", "preview_id is required", "Preview the skill first.");
        return json(await installSkill(env, HUMAN, b.preview_id, { replace: b.replace === true }), 201);
      }
      return methodNotAllowed();
    }

    if (pathname === "/api/skills/settings") {
      if (method === "GET") return json(await getSkillsSettings(db));
      if (method === "PATCH") {
        const b = await readJson(request);
        return json(await setSkillsSettings(db, HUMAN, { scripts_enabled: typeof b.scripts_enabled === "boolean" ? b.scripts_enabled : undefined }));
      }
      return methodNotAllowed();
    }

    if (pathname === "/api/skills/suggested") {
      if (method !== "GET") return methodNotAllowed();
      return json(await suggestedSkills(env));
    }

    // Preview: JSON { url } (GitHub folder) or { skill_md } (paste), or a zip body (application/zip).
    if (pathname === "/api/skills/preview") {
      if (method !== "POST") return methodNotAllowed();
      const type = request.headers.get("content-type") ?? "";
      if (type.includes("zip") || type.includes("octet-stream")) {
        const length = Number(request.headers.get("content-length") ?? "0");
        if (length > 5 * 1024 * 1024) throw new ServiceError("invalid_input", "Zip is too large", "Max 5 MB zipped, 2 MB of files.");
        return json(await previewFromZip(env, await request.arrayBuffer()));
      }
      const b = await readJson(request);
      if (typeof b.url === "string") return json(await previewFromGitHub(env, b.url));
      if (typeof b.skill_md === "string") return json(await previewFromPaste(env, b.skill_md));
      throw new ServiceError("invalid_input", "Nothing to preview", "Send { url }, { skill_md } or a zip.");
    }

    const m = pathname.match(/^\/api\/skills\/([a-z0-9-]+)(?:\/(file|update))?$/);
    if (!m) return json({ error: "Not found", code: "not_found", hint: "Unknown skills route." }, 404);
    const [, name, action] = m as unknown as [string, string, string | undefined];

    if (action === "file") {
      if (method !== "GET") return methodNotAllowed();
      const path = new URL(request.url).searchParams.get("path") ?? "";
      const content = await readSkillFile(env, name, path);
      if (content === null) throw new ServiceError("not_found", `No file ${path}`, "Check the path.", 404);
      return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
    }
    if (action === "update") {
      if (method !== "POST") return methodNotAllowed();
      return json(await previewUpdate(env, HUMAN, name));
    }
    if (method === "GET") return json(await getSkill(env, name));
    if (method === "PATCH") {
      const b = await readJson(request);
      if (typeof b.all_agents !== "boolean") throw new ServiceError("invalid_input", "all_agents (boolean) is required", "");
      return json(await setAllAgents(db, HUMAN, name, b.all_agents));
    }
    if (method === "DELETE") {
      await deleteSkill(env, HUMAN, name);
      return json({ ok: true });
    }
    return methodNotAllowed();
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("skills api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
