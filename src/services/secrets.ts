// Secrets for MCP server headers (task 018, SPEC-mcps 3). Values are encrypted with AES-GCM using
// FLARETOWN_SECRETS_KEY (a Worker secret: base64 of 32 random bytes) and never returned by any API.
// Rotation: FLARETOWN_SECRETS_KEY_PREVIOUS decrypts old rows; reencryptAll() moves them over.

import type { Caller } from "./caller";
import { ServiceError } from "./errors";

type KeyEnv = { FLARETOWN_SECRETS_KEY?: string; FLARETOWN_SECRETS_KEY_PREVIOUS?: string };

export const KEY_HINT =
  "Set the FLARETOWN_SECRETS_KEY Worker secret: generate it with `openssl rand -base64 32`, then `pnpm wrangler secret put FLARETOWN_SECRETS_KEY` (keep a copy: losing it loses these secrets).";
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface LoadedKey {
  id: string;
  key: CryptoKey;
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function loadKey(raw: string | undefined): Promise<LoadedKey | null> {
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    bytes = unb64(raw.trim());
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id, key };
}

async function keys(env: Env) {
  const e = env as unknown as KeyEnv;
  return { current: await loadKey(e.FLARETOWN_SECRETS_KEY), previous: await loadKey(e.FLARETOWN_SECRETS_KEY_PREVIOUS), set: Boolean(e.FLARETOWN_SECRETS_KEY) };
}

async function requireKey(env: Env): Promise<LoadedKey> {
  const k = await keys(env);
  if (!k.current) {
    throw new ServiceError(
      "no_secrets_key",
      k.set ? "FLARETOWN_SECRETS_KEY is not a valid key" : "Secrets are not set up",
      KEY_HINT,
      400,
    );
  }
  return k.current;
}

function requireHuman(caller: Caller) {
  if (caller.kind !== "human") throw new ServiceError("forbidden", "Not allowed: only the human manages secrets", "", 403);
}

type Row = { name: string; ciphertext: string; iv: string; key_id: string; last4: string; description: string; created_at: string; updated_at: string };

export interface SecretInfo {
  name: string;
  masked: string;
  description: string;
  key_id: string;
  readable: boolean; // encrypted with a key we have
  used_by: string[]; // server ids referencing it
  created_at: string;
  updated_at: string;
}

export async function secretsStatus(env: Env) {
  const k = await keys(env);
  const { results } = await env.DB_CORE.prepare("SELECT key_id, COUNT(*) AS n FROM secrets GROUP BY key_id").all<{ key_id: string; n: number }>();
  const total = results.reduce((s, r) => s + r.n, 0);
  const onCurrent = results.find((r) => r.key_id === k.current?.id)?.n ?? 0;
  const onPrevious = results.find((r) => r.key_id === k.previous?.id)?.n ?? 0;
  return {
    key_set: k.set,
    key_valid: Boolean(k.current),
    previous_key: Boolean(k.previous),
    total,
    on_previous_key: onPrevious,
    unreadable: total - onCurrent - onPrevious,
    hint: k.current ? null : KEY_HINT,
  };
}

// Secret names referenced by every server's header templates.
async function usage(db: D1Database): Promise<Map<string, string[]>> {
  const { results } = await db.prepare("SELECT id, headers FROM mcp_servers").all<{ id: string; headers: string }>();
  const map = new Map<string, string[]>();
  for (const r of results) {
    for (const name of referencedSecrets(JSON.parse(r.headers || "{}") as Record<string, string>)) {
      map.set(name, [...(map.get(name) ?? []), r.id]);
    }
  }
  return map;
}

export function referencedSecrets(headers: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const v of Object.values(headers)) for (const m of v.matchAll(/\$\{(?:env:)?([A-Z][A-Z0-9_]*)\}/g)) names.add(m[1]!);
  return [...names];
}

export async function listSecrets(env: Env): Promise<{ secrets: SecretInfo[]; status: Awaited<ReturnType<typeof secretsStatus>> }> {
  const k = await keys(env);
  const used = await usage(env.DB_CORE);
  const { results } = await env.DB_CORE.prepare("SELECT * FROM secrets ORDER BY name").all<Row>();
  return {
    secrets: results.map((r) => ({
      name: r.name,
      masked: `••••${r.last4}`,
      description: r.description,
      key_id: r.key_id,
      readable: r.key_id === k.current?.id || r.key_id === k.previous?.id,
      used_by: used.get(r.name) ?? [],
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    status: await secretsStatus(env),
  };
}

async function encrypt(key: LoadedKey, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key.key, new TextEncoder().encode(value));
  return { ciphertext: b64(ct), iv: b64(iv), key_id: key.id };
}

export async function putSecret(env: Env, caller: Caller, name: string, value: string, description?: string): Promise<SecretInfo> {
  requireHuman(caller);
  if (!NAME_RE.test(name)) throw new ServiceError("invalid_input", `Invalid secret name ${name}`, "Use UPPER_CASE letters, digits and _ (e.g. GITHUB_TOKEN).");
  if (!value) throw new ServiceError("invalid_input", "Value is required", "Paste the token or key.");
  if (value.length > 16_384) throw new ServiceError("invalid_input", "Value is too long", "Max 16 KB.");
  const key = await requireKey(env);
  const enc = await encrypt(key, value);
  const ts = new Date().toISOString();
  await env.DB_CORE.prepare(
    `INSERT INTO secrets (name, ciphertext, iv, key_id, last4, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id,
       last4 = excluded.last4, description = COALESCE(?, secrets.description), updated_at = excluded.updated_at`,
  )
    .bind(name, enc.ciphertext, enc.iv, enc.key_id, value.slice(-4), description ?? "", ts, ts, description ?? null)
    .run();
  return (await listSecrets(env)).secrets.find((s) => s.name === name)!;
}

export async function deleteSecret(env: Env, caller: Caller, name: string): Promise<void> {
  requireHuman(caller);
  await env.DB_CORE.prepare("DELETE FROM secrets WHERE name = ?").bind(name).run();
}

async function decryptRow(env: Env, row: Row): Promise<string> {
  const k = await keys(env);
  const key = row.key_id === k.current?.id ? k.current : row.key_id === k.previous?.id ? k.previous : null;
  if (!key) throw new ServiceError("secret_unreadable", `Secret ${row.name} was encrypted with a key we don't have`, "Enter its value again.", 409);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv) }, key.key, unb64(row.ciphertext));
  return new TextDecoder().decode(pt);
}

// Worker-internal only: resolve ${NAME} references in header templates. Never expose the result.
export async function resolveTemplates(env: Env, templates: Record<string, string>): Promise<Record<string, string>> {
  const names = referencedSecrets(templates);
  const values = new Map<string, string>();
  if (names.length) {
    const { results } = await env.DB_CORE.prepare(`SELECT * FROM secrets WHERE name IN (${names.map(() => "?").join(",")})`)
      .bind(...names)
      .all<Row>();
    const missing = names.filter((n) => !results.some((r) => r.name === n));
    if (missing.length) throw new ServiceError("secret_missing", `Missing secret(s): ${missing.join(", ")}`, "Add them in MCPs → Secrets.", 409);
    for (const r of results) values.set(r.name, await decryptRow(env, r));
  }
  const out: Record<string, string> = {};
  for (const [h, t] of Object.entries(templates)) out[h] = t.replace(/\$\{(?:env:)?([A-Z][A-Z0-9_]*)\}/g, (_, n: string) => values.get(n) ?? "");
  return out;
}

// Remove secret values from any text before it's logged or returned (errors from MCP servers).
export async function redact(env: Env, text: string): Promise<string> {
  const { results } = await env.DB_CORE.prepare("SELECT * FROM secrets").all<Row>();
  let out = text;
  for (const r of results) {
    try {
      const v = await decryptRow(env, r);
      if (v.length >= 4) out = out.split(v).join(`••••${r.last4}`);
    } catch {
      /* unreadable rows can't leak */
    }
  }
  return out;
}

export async function reencryptAll(env: Env, caller: Caller): Promise<{ reencrypted: number; skipped: number }> {
  requireHuman(caller);
  const key = await requireKey(env);
  const { results } = await env.DB_CORE.prepare("SELECT * FROM secrets").all<Row>();
  let reencrypted = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.key_id === key.id) continue;
    try {
      const enc = await encrypt(key, await decryptRow(env, r));
      await env.DB_CORE.prepare("UPDATE secrets SET ciphertext = ?, iv = ?, key_id = ?, updated_at = ? WHERE name = ?")
        .bind(enc.ciphertext, enc.iv, enc.key_id, new Date().toISOString(), r.name)
        .run();
      reencrypted++;
    } catch {
      skipped++;
    }
  }
  return { reencrypted, skipped };
}
