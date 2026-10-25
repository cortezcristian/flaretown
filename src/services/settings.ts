// Instance settings (D1 key/value). Orchestrator settings: SPEC-orchestrator 6.6.

import { ServiceError } from "./errors";

export interface OrchestratorSettings {
  enabled: boolean;
  poll_interval_s: number;
  max_concurrent_per_agent: number;
  stall_timeout_min: number;
  // Global Code Mode switch (task 012). On by default. Off: no agent gets exec.
  code_mode_enabled: boolean;
  // Sandbox (task 013): global switch, off by default, and max running sandboxes per tier.
  sandbox_global_enabled: boolean;
  sandbox_max_principal: number;
  sandbox_max_leads: number;
  sandbox_max_operators: number;
}

// Upper bounds = the most agents a tier can have (1 Principal, MAX_LEADS, MAX_LEADS x MAX_OPERATORS_PER_LEAD).
export const SANDBOX_MAX_BOUNDS = { principal: 1, lead: 5, operator: 25 } as const;

export const POLL_MIN_S = 30;
export const POLL_MAX_S = 3600;

async function readAll(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function getOrchestratorSettings(db: D1Database): Promise<OrchestratorSettings> {
  const s = await readAll(db);
  return {
    enabled: s.orchestrator_enabled === "true",
    poll_interval_s: Number(s.orchestrator_poll_interval_s ?? 300),
    max_concurrent_per_agent: Number(s.orchestrator_max_concurrent_per_agent ?? 1),
    stall_timeout_min: Number(s.orchestrator_stall_timeout_min ?? 10),
    code_mode_enabled: (s.code_mode_enabled ?? "true") === "true",
    sandbox_global_enabled: s.sandbox_global_enabled === "true",
    sandbox_max_principal: Number(s.sandbox_max_principal ?? 1),
    sandbox_max_leads: Number(s.sandbox_max_leads ?? 2),
    sandbox_max_operators: Number(s.sandbox_max_operators ?? 3),
  };
}

export async function updateOrchestratorSettings(db: D1Database, input: Partial<OrchestratorSettings>): Promise<OrchestratorSettings> {
  const next = { ...(await getOrchestratorSettings(db)), ...input };
  if (!Number.isInteger(next.poll_interval_s) || next.poll_interval_s < POLL_MIN_S || next.poll_interval_s > POLL_MAX_S) {
    throw new ServiceError("invalid_input", "Poll interval out of range", `Use ${POLL_MIN_S} to ${POLL_MAX_S} seconds.`);
  }
  if (!Number.isInteger(next.max_concurrent_per_agent) || next.max_concurrent_per_agent < 1 || next.max_concurrent_per_agent > 5) {
    throw new ServiceError("invalid_input", "Max concurrent out of range", "Use 1 to 5.");
  }
  if (!Number.isInteger(next.stall_timeout_min) || next.stall_timeout_min < 1 || next.stall_timeout_min > 1440) {
    throw new ServiceError("invalid_input", "Stall timeout out of range", "Use 1 to 1440 minutes.");
  }
  for (const [key, max] of [
    ["sandbox_max_principal", SANDBOX_MAX_BOUNDS.principal],
    ["sandbox_max_leads", SANDBOX_MAX_BOUNDS.lead],
    ["sandbox_max_operators", SANDBOX_MAX_BOUNDS.operator],
  ] as const) {
    const v = next[key];
    if (!Number.isInteger(v) || v < 0 || v > max) {
      throw new ServiceError("invalid_input", `${key} out of range`, `Use 0 to ${max}.`);
    }
  }
  const put = (key: string, value: string) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value);
  await db.batch([
    put("orchestrator_enabled", String(Boolean(next.enabled))),
    put("orchestrator_poll_interval_s", String(next.poll_interval_s)),
    put("orchestrator_max_concurrent_per_agent", String(next.max_concurrent_per_agent)),
    put("orchestrator_stall_timeout_min", String(next.stall_timeout_min)),
    put("code_mode_enabled", String(Boolean(next.code_mode_enabled))),
    put("sandbox_global_enabled", String(Boolean(next.sandbox_global_enabled))),
    put("sandbox_max_principal", String(next.sandbox_max_principal)),
    put("sandbox_max_leads", String(next.sandbox_max_leads)),
    put("sandbox_max_operators", String(next.sandbox_max_operators)),
  ]);
  return next;
}

export async function getTimezone(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first<{ value: string }>();
  return row?.value || "UTC";
}
