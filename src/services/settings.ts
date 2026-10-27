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
  // Agent limits: active Leads, and active Operators under each Lead.
  agents_max_leads: number;
  agents_max_operators_per_lead: number;
}

// Agent limits: defaults and the range the UI accepts.
export const AGENT_LIMIT_DEFAULTS = { leads: 5, operators_per_lead: 5 } as const;
export const AGENT_LIMIT_MAX = 50;

// Sandbox upper bounds = the most agents a tier can have (1 Principal, max Leads, max Leads x max Operators per Lead).
export function sandboxMaxBounds(s: Pick<OrchestratorSettings, "agents_max_leads" | "agents_max_operators_per_lead">) {
  return { principal: 1, lead: s.agents_max_leads, operator: s.agents_max_leads * s.agents_max_operators_per_lead };
}

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
    agents_max_leads: Number(s.agents_max_leads ?? AGENT_LIMIT_DEFAULTS.leads),
    agents_max_operators_per_lead: Number(s.agents_max_operators_per_lead ?? AGENT_LIMIT_DEFAULTS.operators_per_lead),
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
  for (const [key, label] of [
    ["agents_max_leads", "Max Leads"],
    ["agents_max_operators_per_lead", "Max Operators per Lead"],
  ] as const) {
    const v = next[key];
    if (!Number.isInteger(v) || v < 1 || v > AGENT_LIMIT_MAX) {
      throw new ServiceError("invalid_input", `${label} out of range`, `Use 1 to ${AGENT_LIMIT_MAX}. Lowering it doesn't retire agents, it only blocks new ones.`);
    }
  }
  const bounds = sandboxMaxBounds(next);
  for (const [key, max] of [
    ["sandbox_max_principal", bounds.principal],
    ["sandbox_max_leads", bounds.lead],
    ["sandbox_max_operators", bounds.operator],
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
    put("agents_max_leads", String(next.agents_max_leads)),
    put("agents_max_operators_per_lead", String(next.agents_max_operators_per_lead)),
  ]);
  return next;
}

export async function getTimezone(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first<{ value: string }>();
  return row?.value || "UTC";
}
