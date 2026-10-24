// One Cloudflare Artifacts git repo per agent (SPEC-agents 5.1).
// Reads use the binding (log / readCommit / readTree / readFile). Writes are git commits pushed
// over HTTPS with a short-lived write token, using isomorphic-git on the Worker's in-memory /tmp
// (same approach as references/cloudflare-os/packages/gatekeeper-context/src/artifact-sync.ts).

import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import { posix as path } from "node:path";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { ServiceError } from "./errors";

const WRITE_TOKEN_TTL_S = 600;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface RepoFile {
  path: string;
  // string = write this content; null = delete the file (or folder)
  content: string | Uint8Array | null;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob";
  hash: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string | null;
  parents: string[];
  tree: string | null;
}

// ---- repo per agent -------------------------------------------------------------------------

export function repoNameFor(agentId: string): string {
  return `agent-${agentId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

type Agent = { id: string; name: string; tier: string; area: string; status: string; artifact_repo: string | null };

// Make sure the agent has its repo (created on first use for agents that existed before).
export async function ensureAgentRepo(env: Env, agentId: string): Promise<string> {
  const db = env.DB_CORE;
  const agent = await db
    .prepare("SELECT id, name, tier, area, status, artifact_repo FROM agents WHERE id = ?")
    .bind(agentId)
    .first<Agent>();
  if (!agent) throw new ServiceError("not_found", `Agent ${agentId} not found`, "Check the agent id.", 404);
  if (agent.artifact_repo) return agent.artifact_repo;

  const name = repoNameFor(agent.id);
  try {
    await env.ARTIFACTS_REPOS.create(name, { description: `Flaretown ${agent.tier} ${agent.name}` });
  } catch (err) {
    // Already exists (e.g. a previous attempt): reuse it.
    try {
      await env.ARTIFACTS_REPOS.get(name);
    } catch {
      throw err;
    }
  }
  await db.prepare("UPDATE agents SET artifact_repo = ? WHERE id = ?").bind(name, agent.id).run();

  // Initial content (SPEC-agents 5.1.1 layout).
  await commitFiles(env, name, [
    {
      path: "README.md",
      content: `# ${agent.name}\n\nFlaretown ${agent.tier}${agent.area ? `. Area: ${agent.area}` : ""}.\n\n- \`tasks/<identifier>/\`: what this agent produced for each task (expires, see retention)\n- \`NOTES.md\`: durable notes, never expire\n`,
    },
    { path: "NOTES.md", content: `# Notes\n\nDurable notes for ${agent.name}. Never expire.\n` },
  ], "Initial commit", agent.name).catch((err) => console.error("initial commit failed", name, err));
  return name;
}

// ---- write ----------------------------------------------------------------------------------

async function rmrf(dir: string) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function cleanPath(p: string): string {
  const clean = path.normalize(p.replace(/^\/+/, ""));
  if (!clean || clean === "." || clean.startsWith("..") || clean.split("/").includes(".git")) {
    throw new ServiceError("invalid_input", `Invalid path ${p}`, "Use a relative path inside the repo.");
  }
  return clean;
}

// One commit with all the files, pushed to the repo's default branch. Retries once if the
// branch moved meanwhile (another write).
export async function commitFiles(env: Env, repoName: string, files: RepoFile[], message: string, authorName: string): Promise<string> {
  for (const f of files) {
    f.path = cleanPath(f.path);
    const size = f.content === null ? 0 : typeof f.content === "string" ? new TextEncoder().encode(f.content).byteLength : f.content.byteLength;
    if (size > MAX_FILE_BYTES) throw new ServiceError("invalid_input", `${f.path} is too large`, "Keep files under 2 MB.");
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await commitOnce(env, repoName, files, message, authorName);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof ServiceError ? lastErr : new ServiceError("repo_write_failed", `Couldn't write to ${repoName}`, String(lastErr), 502);
}

async function commitOnce(env: Env, repoName: string, files: RepoFile[], message: string, authorName: string): Promise<string> {
  const repo = await env.ARTIFACTS_REPOS.get(repoName);
  const info = await repo.info();
  const branch = info.defaultBranch || "main";
  const token = await repo.createToken("write", WRITE_TOKEN_TTL_S);
  const onAuth = () => ({ username: "x-access-token", password: token.plaintext });
  const newDir = () => `/tmp/repo-${crypto.randomUUID()}`;
  const dirs = [newDir()];
  let dir = dirs[0]!;
  try {
    let empty = false;
    try {
      await git.clone({ fs, http, dir, url: info.remote, ref: branch, singleBranch: true, depth: 1, noTags: true, onAuth });
      // On an empty remote, clone returns early without error and HEAD points to "master".
      await git.resolveRef({ fs, dir, ref: branch });
    } catch {
      // Empty repo (no commits yet): start one on the default branch.
      // Use a fresh folder: leftovers of the failed clone would make init a no-op (HEAD on master).
      empty = true;
      dir = newDir();
      dirs.push(dir);
      await fsp.mkdir(dir, { recursive: true });
      await git.init({ fs, dir, defaultBranch: branch });
      await git.addRemote({ fs, dir, remote: "origin", url: info.remote });
    }

    for (const f of files) {
      const full = path.join(dir, f.path);
      if (f.content === null) {
        const matches = (await git.listFiles({ fs, dir }).catch(() => [] as string[])).filter(
          (p) => p === f.path || p.startsWith(`${f.path}/`),
        );
        for (const m of matches) {
          await git.remove({ fs, dir, filepath: m });
          await fsp.rm(path.join(dir, m), { force: true }).catch(() => {});
        }
        continue;
      }
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, f.content);
      await git.add({ fs, dir, filepath: f.path });
    }

    if (!empty) {
      const status = await git.statusMatrix({ fs, dir });
      const changed = status.some(([, head, work, stage]) => head !== work || work !== stage);
      if (!changed) return (await git.resolveRef({ fs, dir, ref: "HEAD" })) as string;
    }

    const hash = await git.commit({
      fs,
      dir,
      ref: `refs/heads/${branch}`,
      message,
      author: { name: authorName, email: "agents@flaretown.local" },
    });
    await git.push({ fs, http, dir, remote: "origin", ref: branch, onAuth });
    return hash;
  } finally {
    for (const d of dirs) await rmrf(d);
    repo.revokeToken(token.id).catch(() => {});
  }
}

// ---- read -----------------------------------------------------------------------------------

/* The binding's result types aren't fully documented; normalize defensively. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function commitOf(c: Any, fallbackHash = ""): CommitInfo {
  const author = c?.author ?? c?.committer ?? {};
  const date = author?.date ?? author?.timestamp ?? c?.date ?? c?.timestamp ?? null;
  return {
    hash: String(c?.hash ?? c?.oid ?? c?.sha ?? fallbackHash),
    message: String(c?.message ?? "").trim(),
    author: String(author?.name ?? c?.authorName ?? ""),
    date: typeof date === "number" ? new Date(date > 1e12 ? date : date * 1000).toISOString() : date ? String(date) : null,
    parents: (c?.parents ?? c?.parent ?? []) as string[],
    tree: c?.tree ?? c?.treeHash ?? c?.tree_hash ?? null,
  };
}

function entryOf(e: Any, base: string): TreeEntry {
  const name = String(e?.name ?? e?.path ?? "");
  const mode = String(e?.mode ?? "");
  const type: "tree" | "blob" = e?.type === "tree" || mode.startsWith("40") || mode === "040000" ? "tree" : "blob";
  return { name, path: base ? `${base}/${name}` : name, type, hash: String(e?.hash ?? e?.oid ?? e?.sha ?? "") };
}

async function getRepo(env: Env, repoName: string) {
  try {
    return await env.ARTIFACTS_REPOS.get(repoName);
  } catch {
    throw new ServiceError("not_found", `Repo ${repoName} not found`, "The agent's repo is created on first use.", 404);
  }
}

export async function repoLog(env: Env, repoName: string, limit = 50): Promise<CommitInfo[]> {
  const repo = await getRepo(env, repoName);
  const info = await repo.info();
  const log = (await repo.log({ ref: info.defaultBranch || "main", limit })) as Any[];
  return log.map((c) => commitOf(c));
}

async function treeAt(env: Env, repoName: string, ref?: string): Promise<{ repo: Any; tree: string | null; head: string | null }> {
  const repo = await getRepo(env, repoName);
  const info = await repo.info();
  const [head] = (await repo.log({ ref: ref ?? (info.defaultBranch || "main"), limit: 1 })) as Any[];
  if (!head) return { repo, tree: null, head: null };
  const commit = commitOf(head);
  let tree = commit.tree;
  if (!tree) tree = commitOf(await repo.readCommit(commit.hash)).tree;
  return { repo, tree, head: commit.hash };
}

// Immediate children at a path ("" = root).
export async function repoTree(env: Env, repoName: string, dirPath = ""): Promise<{ head: string | null; entries: TreeEntry[] }> {
  const { repo, tree, head } = await treeAt(env, repoName);
  if (!tree) return { head, entries: [] };
  let hash: string | null = tree;
  let base = "";
  for (const part of dirPath.split("/").filter(Boolean)) {
    const entries: TreeEntry[] = ((await repo.readTree(hash)) ?? []).map((e: Any) => entryOf(e, base));
    const next: TreeEntry | undefined = entries.find((e: TreeEntry) => e.name === part && e.type === "tree");
    if (!next) throw new ServiceError("not_found", `No folder ${dirPath}`, "Check the path.", 404);
    hash = next.hash;
    base = base ? `${base}/${part}` : part;
  }
  const entries = ((await repo.readTree(hash)) ?? []).map((e: Any) => entryOf(e, base)) as TreeEntry[];
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
  return { head, entries };
}

export async function repoFile(env: Env, repoName: string, filePath: string, ref?: string): Promise<{ blob: Blob; type: string } | null> {
  const repo = await getRepo(env, repoName);
  const info = await repo.info();
  const blob = (await repo.readFile({ ref: ref ?? (info.defaultBranch || "main"), path: cleanPath(filePath) })) as Blob | null;
  if (!blob) return null;
  return { blob, type: blob.type || "application/octet-stream" };
}

// All files under a tree, recursively (bounded), as path -> blob hash.
async function flatten(repo: Any, hash: string | null, base = "", out = new Map<string, string>(), budget = { n: 2000 }): Promise<Map<string, string>> {
  if (!hash || budget.n <= 0) return out;
  for (const e of ((await repo.readTree(hash)) ?? []).map((x: Any) => entryOf(x, base)) as TreeEntry[]) {
    if (--budget.n <= 0) break;
    if (e.type === "tree") await flatten(repo, e.hash, e.path, out, budget);
    else out.set(e.path, e.hash);
  }
  return out;
}

// Files changed by a commit (vs its first parent), with before/after text for small text files.
export async function repoCommitChanges(
  env: Env,
  repoName: string,
  commitHash: string,
): Promise<{ commit: CommitInfo; files: Array<{ path: string; change: "added" | "deleted" | "modified"; before: string | null; after: string | null }> }> {
  const repo = await getRepo(env, repoName);
  const raw = await repo.readCommit(commitHash);
  if (!raw) throw new ServiceError("not_found", `No commit ${commitHash}`, "Use the history list.", 404);
  const commit = commitOf(raw, commitHash);
  const parent = commit.parents[0] ? commitOf(await repo.readCommit(commit.parents[0]), commit.parents[0]) : null;
  const [now, before] = await Promise.all([flatten(repo, commit.tree), flatten(repo, parent?.tree ?? null)]);
  const text = async (h?: string) => {
    if (!h) return null;
    const b = (await repo.readBlob(h)) as Blob | null;
    if (!b || b.size > 200_000) return null;
    return b.text();
  };
  const files: Array<{ path: string; change: "added" | "deleted" | "modified"; before: string | null; after: string | null }> = [];
  for (const p of new Set([...now.keys(), ...before.keys()])) {
    const a = before.get(p), b = now.get(p);
    if (a === b) continue;
    files.push({ path: p, change: !a ? "added" : !b ? "deleted" : "modified", before: await text(a), after: await text(b) });
    if (files.length >= 50) break;
  }
  return { commit, files };
}
