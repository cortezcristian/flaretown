// The skill source each agent hands to Think's getSkills() (task 017, SPEC-skills 3.2).
// Lists only the agent's skills (its own + all-agents ones) and reads them from the Worker
// bundle or the R2 library. Think calls refresh() every turn; the fingerprint changes when the
// agent's list or any of its skills changes, so assignment edits apply on the next message.

import type { SkillContent, SkillDescriptor, SkillResource, SkillResourceDescriptor, SkillSource } from "agents/skills";
import { agentSkillNames, bundledFiles, parseSkill, readSkillFile } from "../services/skills";

function kindOf(path: string): SkillResourceDescriptor["kind"] {
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  return "file";
}

export class FlaretownSkillSource implements SkillSource {
  readonly id = "flaretown";
  private names: string[] = [];
  private print = "";
  private loaded = false;

  constructor(
    private env: Env,
    private agentId: () => string,
  ) {}

  get fingerprint(): string {
    return this.print;
  }

  async refresh(): Promise<void> {
    const { names, fingerprint } = await agentSkillNames(this.env.DB_CORE, this.agentId());
    this.names = names;
    this.print = fingerprint;
    this.loaded = true;
  }

  async list(): Promise<SkillDescriptor[]> {
    if (!this.loaded) await this.refresh();
    if (!this.names.length) return [];
    const { results } = await this.env.DB_CORE.prepare(
      `SELECT name, description, license, version FROM skills WHERE name IN (${this.names.map(() => "?").join(",")})`,
    )
      .bind(...this.names)
      .all<{ name: string; description: string; license: string | null; version: string | null }>();
    return results.map((r) => ({
      name: r.name,
      description: r.description,
      ...(r.license ? { license: r.license } : {}),
      ...(r.version ? { version: r.version } : {}),
    }));
  }

  private async fileList(name: string): Promise<Array<{ path: string; size: number }>> {
    const bundled = bundledFiles(name);
    if (bundled) return Object.entries(bundled).map(([path, c]) => ({ path, size: c.length }));
    const row = await this.env.DB_CORE.prepare("SELECT files FROM skills WHERE name = ?").bind(name).first<{ files: string }>();
    return row ? (JSON.parse(row.files) as Array<{ path: string; size: number }>) : [];
  }

  async load(name: string): Promise<SkillContent | null> {
    if (!this.names.includes(name)) return null;
    const raw = await readSkillFile(this.env, name, "SKILL.md");
    if (!raw) return null;
    const meta = parseSkill(raw);
    const resources = (await this.fileList(name))
      .filter((f) => f.path !== "SKILL.md")
      .map((f) => ({ path: f.path, kind: kindOf(f.path), size: f.size, encoding: "text" as const }));
    return { name, description: meta.description, body: meta.body, rawContent: raw, resources };
  }

  async readResource(name: string, path: string): Promise<SkillResource | null> {
    if (!this.names.includes(name)) return null;
    const content = await readSkillFile(this.env, name, path);
    if (content === null) return null;
    return { path, kind: kindOf(path), size: content.length, encoding: "text", content };
  }
}
