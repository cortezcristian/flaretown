// Skills library and assignment (task 017, SPEC-skills). The only place skill rules live.
// Library files: R2 (ARTIFACTS) skills/<name>/<path>. Bundled skills: src/skills/bundled.generated.ts.

import { parseSkillMarkdown } from "agents/skills";
import { BUNDLED_SKILLS } from "../skills/bundled.generated";
import { readZip } from "../skills/zip";
import { type Caller, isHumanOrPrincipal } from "./caller";
import { ServiceError } from "./errors";

export type SkillSourceKind = "bundled" | "github" | "upload" | "paste";

export interface SkillFile {
  path: string;
  size: number;
}

export interface Skill {
  name: string;
  description: string;
  source: SkillSourceKind;
  source_url: string | null;
  source_ref: string | null;
  license: string | null;
  version: string | null;
  size: number;
  files: SkillFile[];
  all_agents: boolean;
  installed_by: string;
  installed_at: string;
  updated_at: string;
  agents: number; // agents that have it explicitly
}

export const LIBRARY_PREFIX = "skills/";
const PREVIEW_PREFIX = "skill-previews/";
const LIMITS = { maxFiles: 100, maxBytes: 2 * 1024 * 1024 };
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|ts|tsx|js|mjs|cjs|py|sh|bash|html|css|csv|xml|sql|ini|cfg|conf|env\.example)$/i;

const now = () => new Date().toISOString();
type Row = Omit<Skill, "files" | "all_agents" | "agents"> & { files: string; all_agents: number; agents?: number };

function toSkill(r: Row): Skill {
  return { ...r, files: JSON.parse(r.files || "[]") as SkillFile[], all_agents: r.all_agents === 1, agents: r.agents ?? 0 };
}

function isText(path: string, data: Uint8Array): boolean {
  const base = path.split("/").pop() ?? "";
  if (!TEXT_EXT.test(path) && !/^(LICENSE|NOTICE|README|COPYING)/i.test(base)) return false;
  return !data.subarray(0, 8000).includes(0);
}

// ---- parsing ---------------------------------------------------------------------------------

export interface ParsedSkill {
  name: string;
  description: string;
  license: string | null;
  version: string | null;
  body: string;
}

export function parseSkill(raw: string): ParsedSkill {
  const parsed = parseSkillMarkdown(raw);
  if (!parsed) {
    throw new ServiceError("invalid_input", "SKILL.md has no valid frontmatter", "It must start with --- and include name and description.");
  }
  if (!NAME_RE.test(parsed.name)) {
    throw new ServiceError("invalid_input", `Invalid skill name "${parsed.name}"`, "Use lowercase letters, digits and dashes (max 64).");
  }
  if (!parsed.description?.trim()) throw new ServiceError("invalid_input", "Skill has no description", "Add description: to the frontmatter.");
  const version = parsed.metadata?.version;
  return {
    name: parsed.name,
    description: parsed.description.trim(),
    license: parsed.license ?? null,
    version: typeof version === "string" || typeof version === "number" ? String(version) : null,
    body: parsed.body,
  };
}

// ---- bundled ---------------------------------------------------------------------------------

export function bundledNames(): string[] {
  return Object.keys(BUNDLED_SKILLS);
}

export function bundledFiles(name: string): Record<string, string> | null {
  return BUNDLED_SKILLS[name] ?? null;
}

// Bundled skills get a D1 row the first time they're seen (all agents by default), so they can be
// listed, assigned and toggled like the rest. Content always comes from the Worker bundle.
export async function syncBundled(db: D1Database): Promise<void> {
  const names = bundledNames();
  if (!names.length) return;
  const ts = now();
  await db.batch(
    names.map((name) => {
      const files = bundledFiles(name)!;
      const meta = parseSkill(files["SKILL.md"]!);
      const list = Object.entries(files).map(([path, content]) => ({ path, size: new TextEncoder().encode(content).length }));
      return db
        .prepare(
          `INSERT INTO skills (name, description, source, license, version, size, files, all_agents, installed_by, installed_at, updated_at)
           VALUES (?, ?, 'bundled', ?, ?, ?, ?, 1, 'system', ?, ?)
           ON CONFLICT (name) DO UPDATE SET description = excluded.description, source = 'bundled', license = excluded.license,
             version = excluded.version, size = excluded.size, files = excluded.files, updated_at = CASE
               WHEN skills.files = excluded.files AND skills.description = excluded.description THEN skills.updated_at ELSE excluded.updated_at END`,
        )
        .bind(name, meta.description, meta.license, meta.version, list.reduce((n, f) => n + f.size, 0), JSON.stringify(list), ts, ts);
    }),
  );
}

// ---- read ------------------------------------------------------------------------------------

export async function listSkills(db: D1Database): Promise<Skill[]> {
  await syncBundled(db);
  const { results } = await db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM agent_skills a JOIN agents g ON g.id = a.agent_id
                    WHERE a.skill_name = s.name AND g.status = 'active') AS agents
       FROM skills s ORDER BY CASE s.source WHEN 'bundled' THEN 0 ELSE 1 END, s.name`,
    )
    .all<Row>();
  return results.map(toSkill);
}

async function findSkill(db: D1Database, name: string): Promise<Skill> {
  const row = await db.prepare("SELECT * FROM skills WHERE name = ?").bind(name).first<Row>();
  if (!row) throw new ServiceError("not_found", `Skill ${name} not found`, "See the Skills section for installed skills.", 404);
  return toSkill(row);
}

export async function readSkillFile(env: Env, name: string, path: string): Promise<string | null> {
  const bundled = bundledFiles(name);
  if (bundled) return bundled[path] ?? null;
  const obj = await env.ARTIFACTS.get(`${LIBRARY_PREFIX}${name}/${path}`);
  return obj ? obj.text() : null;
}

export async function getSkill(env: Env, name: string) {
  await syncBundled(env.DB_CORE);
  const skill = await findSkill(env.DB_CORE, name);
  const { results } = await env.DB_CORE.prepare(
    `SELECT g.id, g.name, g.tier FROM agent_skills a JOIN agents g ON g.id = a.agent_id
     WHERE a.skill_name = ? AND g.status = 'active' ORDER BY g.name`,
  )
    .bind(name)
    .all<{ id: string; name: string; tier: string }>();
  return { ...skill, skill_md: (await readSkillFile(env, name, "SKILL.md")) ?? "", agent_list: results };
}

// ---- previews (GitHub / zip / paste) ---------------------------------------------------------

export interface Preview {
  id: string;
  source: Exclude<SkillSourceKind, "bundled">;
  source_url: string | null;
  source_ref: string | null;
  name: string;
  description: string;
  license: string | null;
  version: string | null;
  skill_md: string;
  files: Record<string, string>;
  exists: boolean; // a skill with this name is already installed (install = update only for its own source)
}

function stripCommonRoot(files: Record<string, string>): Record<string, string> {
  if (files["SKILL.md"]) return files;
  const roots = new Set(Object.keys(files).map((p) => p.split("/")[0]));
  if (roots.size !== 1) return files;
  const [root] = [...roots];
  if (!files[`${root}/SKILL.md`]) return files;
  return Object.fromEntries(Object.entries(files).map(([p, c]) => [p.slice(root!.length + 1), c]));
}

async function storePreview(env: Env, input: Omit<Preview, "id" | "name" | "description" | "license" | "version" | "skill_md" | "exists">): Promise<Preview> {
  const files = stripCommonRoot(input.files);
  const skillMd = files["SKILL.md"];
  if (!skillMd) throw new ServiceError("invalid_input", "No SKILL.md at the skill's root", "A skill is a folder with SKILL.md at its top level.");
  const meta = parseSkill(skillMd);
  if (bundledNames().includes(meta.name)) {
    throw new ServiceError("conflict", `"${meta.name}" is a bundled skill`, "Bundled skills can't be replaced. Rename the skill in its frontmatter.", 409);
  }
  const existing = await env.DB_CORE.prepare("SELECT source FROM skills WHERE name = ?").bind(meta.name).first<{ source: string }>();
  const preview: Preview = {
    ...input,
    files,
    id: crypto.randomUUID(),
    name: meta.name,
    description: meta.description,
    license: meta.license ?? (Object.keys(files).some((p) => /^LICENSE/i.test(p)) ? "see LICENSE" : null),
    version: meta.version,
    skill_md: skillMd,
    exists: Boolean(existing),
  };
  await env.ARTIFACTS.put(`${PREVIEW_PREFIX}${preview.id}.json`, JSON.stringify(preview), {
    httpMetadata: { contentType: "application/json" },
  });
  return preview;
}

export async function previewFromPaste(env: Env, skillMd: string): Promise<Preview> {
  if (!skillMd?.trim()) throw new ServiceError("invalid_input", "Paste a SKILL.md", "Frontmatter with name and description, then the instructions.");
  return storePreview(env, { source: "paste", source_url: null, source_ref: null, files: { "SKILL.md": skillMd } });
}

export async function previewFromZip(env: Env, zip: ArrayBuffer): Promise<Preview> {
  let entries;
  try {
    entries = await readZip(zip, LIMITS);
  } catch (err) {
    throw new ServiceError("invalid_input", err instanceof Error ? err.message : "Bad zip", "Zip one skill folder (SKILL.md at its root), up to 100 files and 2 MB.");
  }
  const files: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (const e of entries) if (isText(e.path, e.data)) files[e.path] = decoder.decode(e.data);
  return storePreview(env, { source: "upload", source_url: null, source_ref: null, files });
}

// https://github.com/<owner>/<repo>/tree/<ref>/<path>
function parseGitHubUrl(url: string): { owner: string; repo: string; ref: string; path: string } {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([^/]+)\/(.+?)\/?$/);
  if (!m) {
    throw new ServiceError("invalid_input", "Not a GitHub folder URL", "Use https://github.com/<owner>/<repo>/tree/<branch>/<path-to-skill-folder>.");
  }
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), ref: m[3]!, path: m[4]! };
}

const GH_HEADERS = { "user-agent": "flaretown", accept: "application/vnd.github+json" };

async function githubTree(owner: string, repo: string, ref: string): Promise<Array<{ path: string; type: string; size?: number }>> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers: GH_HEADERS });
  if (res.status === 403 || res.status === 429) {
    throw new ServiceError("rate_limited", "GitHub API rate limit reached", "Unauthenticated imports allow 60 requests per hour. Try again later.", 429);
  }
  if (!res.ok) throw new ServiceError("not_found", `GitHub repo or branch not found (${res.status})`, "Check the URL; the repo must be public.", 404);
  const body = (await res.json()) as { tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
  return body.tree;
}

async function rawFile(owner: string, repo: string, ref: string, path: string): Promise<Uint8Array> {
  const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { "user-agent": "flaretown" },
  });
  if (!res.ok) throw new ServiceError("upstream", `Couldn't fetch ${path} (${res.status})`, "Try again.", 502);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchGitHubSkill(url: string): Promise<{ files: Record<string, string>; ref: string; url: string }> {
  const { owner, repo, ref, path } = parseGitHubUrl(url);
  const tree = await githubTree(owner, repo, ref);
  const prefix = `${path.replace(/\/$/, "")}/`;
  const blobs = tree.filter((t) => t.type === "blob" && t.path.startsWith(prefix));
  if (!blobs.some((b) => b.path === `${prefix}SKILL.md`)) {
    throw new ServiceError("invalid_input", "No SKILL.md in that folder", "Point the URL at the skill's folder (the one with SKILL.md).");
  }
  if (blobs.length > LIMITS.maxFiles) throw new ServiceError("invalid_input", `Too many files (${blobs.length})`, `Max ${LIMITS.maxFiles}.`);
  const total = blobs.reduce((n, b) => n + (b.size ?? 0), 0);
  if (total > LIMITS.maxBytes) throw new ServiceError("invalid_input", "Skill is over 2 MB", "Only small, text-based skills are supported.");

  const files: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (const b of blobs) {
    const rel = b.path.slice(prefix.length);
    const data = await rawFile(owner, repo, ref, b.path);
    if (isText(rel, data)) files[rel] = decoder.decode(data);
  }
  // Keep the repo's license with the skill when the folder has none.
  if (!Object.keys(files).some((p) => /^LICENSE/i.test(p))) {
    const lic = tree.find((t) => t.type === "blob" && /^LICENSE(\.(md|txt))?$/i.test(t.path));
    if (lic) files.LICENSE = decoder.decode(await rawFile(owner, repo, ref, lic.path));
  }
  return { files, ref, url: `https://github.com/${owner}/${repo}/tree/${ref}/${path}` };
}

export async function previewFromGitHub(env: Env, url: string): Promise<Preview> {
  const { files, ref, url: clean } = await fetchGitHubSkill(url);
  return storePreview(env, { source: "github", source_url: clean, source_ref: ref, files });
}

// ---- install / update / delete ---------------------------------------------------------------

function requireHuman(caller: Caller, action: string) {
  if (caller.kind !== "human") throw new ServiceError("forbidden", `Not allowed: only the human can ${action}`, "Skills are instructions agents follow; a person reviews them.", 403);
}

async function deleteFiles(env: Env, name: string) {
  let cursor: string | undefined;
  do {
    const page = await env.ARTIFACTS.list({ prefix: `${LIBRARY_PREFIX}${name}/`, cursor });
    if (page.objects.length) await env.ARTIFACTS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function writeSkill(env: Env, preview: Preview, by: string, existing: boolean) {
  await deleteFiles(env, preview.name);
  const list: SkillFile[] = [];
  for (const [path, content] of Object.entries(preview.files)) {
    await env.ARTIFACTS.put(`${LIBRARY_PREFIX}${preview.name}/${path}`, content);
    list.push({ path, size: new TextEncoder().encode(content).length });
  }
  const ts = now();
  const size = list.reduce((n, f) => n + f.size, 0);
  if (existing) {
    await env.DB_CORE.prepare(
      `UPDATE skills SET description = ?, source = ?, source_url = ?, source_ref = ?, license = ?, version = ?, size = ?, files = ?, updated_at = ?
       WHERE name = ?`,
    )
      .bind(preview.description, preview.source, preview.source_url, preview.source_ref, preview.license, preview.version, size, JSON.stringify(list), ts, preview.name)
      .run();
  } else {
    await env.DB_CORE.prepare(
      `INSERT INTO skills (name, description, source, source_url, source_ref, license, version, size, files, all_agents, installed_by, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
      .bind(preview.name, preview.description, preview.source, preview.source_url, preview.source_ref, preview.license, preview.version, size, JSON.stringify(list), by, ts, ts)
      .run();
  }
}

export async function installSkill(env: Env, caller: Caller, previewId: string, opts: { replace?: boolean } = {}): Promise<Skill> {
  requireHuman(caller, "install skills");
  const obj = await env.ARTIFACTS.get(`${PREVIEW_PREFIX}${previewId}.json`);
  if (!obj) throw new ServiceError("not_found", "Preview expired or not found", "Preview the skill again.", 404);
  const preview = (await obj.json()) as Preview;
  const existing = await env.DB_CORE.prepare("SELECT source FROM skills WHERE name = ?").bind(preview.name).first<{ source: string }>();
  if (existing && !opts.replace) {
    throw new ServiceError("conflict", `A skill named ${preview.name} is already installed`, "Replace it, or rename the new one in its frontmatter.", 409);
  }
  await writeSkill(env, preview, "human", Boolean(existing));
  await env.ARTIFACTS.delete(`${PREVIEW_PREFIX}${previewId}.json`);
  return findSkill(env.DB_CORE, preview.name);
}

// Re-import a GitHub skill from its source; returns a preview to review (install with replace).
export async function previewUpdate(env: Env, caller: Caller, name: string): Promise<Preview> {
  requireHuman(caller, "update skills");
  const skill = await findSkill(env.DB_CORE, name);
  if (skill.source !== "github" || !skill.source_url) {
    throw new ServiceError("invalid_input", `${name} wasn't imported from GitHub`, "Upload or paste the new version instead.");
  }
  const preview = await previewFromGitHub(env, skill.source_url);
  if (preview.name !== name) throw new ServiceError("conflict", `The source now names the skill "${preview.name}"`, "Install it as a new skill instead.", 409);
  return preview;
}

export async function deleteSkill(env: Env, caller: Caller, name: string): Promise<void> {
  requireHuman(caller, "delete skills");
  const skill = await findSkill(env.DB_CORE, name);
  if (skill.source === "bundled") throw new ServiceError("forbidden", "Bundled skills can't be deleted", "Turn off All agents and remove it from agents instead.", 403);
  await deleteFiles(env, name);
  await env.DB_CORE.batch([
    env.DB_CORE.prepare("DELETE FROM agent_skills WHERE skill_name = ?").bind(name),
    env.DB_CORE.prepare("DELETE FROM skills WHERE name = ?").bind(name),
  ]);
}

export async function setAllAgents(db: D1Database, caller: Caller, name: string, allAgents: boolean): Promise<Skill> {
  requireHuman(caller, "change skills");
  await findSkill(db, name);
  await db.prepare("UPDATE skills SET all_agents = ?, updated_at = ? WHERE name = ?").bind(allAgents ? 1 : 0, now(), name).run();
  return findSkill(db, name);
}

// ---- assignment ------------------------------------------------------------------------------

// Skills an agent has: its own plus the all-agents ones. Used by the agent's skill source.
export async function agentSkillNames(db: D1Database, agentId: string): Promise<{ names: string[]; fingerprint: string }> {
  await syncBundled(db);
  const { results } = await db
    .prepare(
      `SELECT s.name, s.updated_at FROM skills s
       WHERE s.all_agents = 1 OR s.name IN (SELECT skill_name FROM agent_skills WHERE agent_id = ?)
       ORDER BY s.name`,
    )
    .bind(agentId)
    .all<{ name: string; updated_at: string }>();
  return { names: results.map((r) => r.name), fingerprint: results.map((r) => `${r.name}@${r.updated_at}`).join(",") };
}

export async function getAgentSkills(db: D1Database, agentId: string) {
  await syncBundled(db);
  const { results } = await db
    .prepare(
      `SELECT s.name, s.description, s.source, s.all_agents,
         EXISTS (SELECT 1 FROM agent_skills a WHERE a.agent_id = ? AND a.skill_name = s.name) AS assigned
       FROM skills s ORDER BY s.name`,
    )
    .bind(agentId)
    .all<{ name: string; description: string; source: string; all_agents: number; assigned: number }>();
  return {
    skills: results.map((r) => ({ ...r, all_agents: r.all_agents === 1, assigned: r.assigned === 1, active: r.all_agents === 1 || r.assigned === 1 })),
  };
}

// The human, the Principal (any agent) and a Lead (its own Operators) can set an agent's skills.
export async function setAgentSkills(db: D1Database, caller: Caller, agentId: string, names: string[]) {
  const agent = await db.prepare("SELECT id, tier, parent_id, status FROM agents WHERE id = ?").bind(agentId).first<{
    id: string;
    tier: string;
    parent_id: string | null;
    status: string;
  }>();
  if (!agent) throw new ServiceError("not_found", `Agent ${agentId} not found`, "Check the agent id.", 404);
  if (agent.status !== "active") throw new ServiceError("invalid_state", `${agentId} is retired`, "", 409);
  if (!isHumanOrPrincipal(caller)) {
    const isLeadOfIt = caller.kind === "agent" && agent.tier === "operator" && agent.parent_id === caller.id;
    if (!isLeadOfIt) {
      throw new ServiceError("forbidden", "Not allowed: only the Principal, the human or its Lead can set an agent's skills", "", 403);
    }
  }
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length) {
    const { results } = await db
      .prepare(`SELECT name FROM skills WHERE name IN (${unique.map(() => "?").join(",")})`)
      .bind(...unique)
      .all<{ name: string }>();
    const known = new Set(results.map((r) => r.name));
    const missing = unique.filter((n) => !known.has(n));
    if (missing.length) throw new ServiceError("invalid_input", `Unknown skill(s): ${missing.join(", ")}`, "Install them in the Skills section first.");
  }
  const ts = now();
  await db.batch([
    db.prepare("DELETE FROM agent_skills WHERE agent_id = ?").bind(agentId),
    ...unique.map((n) => db.prepare("INSERT INTO agent_skills (agent_id, skill_name, added_at) VALUES (?, ?, ?)").bind(agentId, n, ts)),
  ]);
  return getAgentSkills(db, agentId);
}

// ---- settings and suggestions ----------------------------------------------------------------

export async function getSkillsSettings(db: D1Database): Promise<{ scripts_enabled: boolean }> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'skills_scripts_enabled'").first<{ value: string }>();
  return { scripts_enabled: row?.value === "true" };
}

export async function setSkillsSettings(db: D1Database, caller: Caller, input: { scripts_enabled?: boolean }) {
  requireHuman(caller, "change skill settings");
  if (typeof input.scripts_enabled === "boolean") {
    await db
      .prepare("INSERT INTO settings (key, value) VALUES ('skills_scripts_enabled', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(String(input.scripts_enabled))
      .run();
  }
  return getSkillsSettings(db);
}

const SUGGESTED_REPO = { owner: "cloudflare", repo: "skills", ref: "main", dir: "skills" };
const SUGGESTED_CACHE = `${PREVIEW_PREFIX}suggested.json`;
const DAY_MS = 86_400_000;

// Official Cloudflare skills (github.com/cloudflare/skills), cached for a day in R2.
export async function suggestedSkills(env: Env) {
  const cached = await env.ARTIFACTS.get(SUGGESTED_CACHE);
  let list: Array<{ name: string; description: string; url: string }> | null = null;
  if (cached && Date.now() - cached.uploaded.getTime() < DAY_MS) list = await cached.json();
  if (!list) {
    const { owner, repo, ref, dir } = SUGGESTED_REPO;
    const tree = await githubTree(owner, repo, ref);
    const skillMds = tree.filter((t) => t.type === "blob" && new RegExp(`^${dir}/[^/]+/SKILL\\.md$`).test(t.path));
    list = [];
    for (const t of skillMds) {
      const folder = t.path.split("/")[1]!;
      try {
        const meta = parseSkill(new TextDecoder().decode(await rawFile(owner, repo, ref, t.path)));
        list.push({ name: meta.name, description: meta.description, url: `https://github.com/${owner}/${repo}/tree/${ref}/${dir}/${folder}` });
      } catch {
        /* skip skills we can't parse */
      }
    }
    await env.ARTIFACTS.put(SUGGESTED_CACHE, JSON.stringify(list), { httpMetadata: { contentType: "application/json" } });
  }
  const { results } = await env.DB_CORE.prepare("SELECT name FROM skills").all<{ name: string }>();
  const installed = new Set(results.map((r) => r.name));
  return { source: `https://github.com/${SUGGESTED_REPO.owner}/${SUGGESTED_REPO.repo}`, skills: list.map((s) => ({ ...s, installed: installed.has(s.name) })) };
}
