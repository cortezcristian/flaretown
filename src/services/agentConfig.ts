// Per-agent settings: model, response format, compaction threshold (SPEC-ui 5.3, SPEC-agents 9).

import {
  COMPACT_MAX_RATIO,
  COMPACT_MIN_TOKENS,
  contextWindowOf,
  defaultCompactAfter,
  isMainModel,
  MAIN_MODELS,
  PRINCIPAL_MODEL,
} from "../models";
import { ServiceError } from "./errors";
import { checkImageName, checkInstance, effectiveInstance, type InstanceType } from "./containers";
import { getOrchestratorSettings } from "./settings";

export type ResponseFormat = "markdown" | "plain";

export interface AgentConfig {
  agent_id: string;
  model: string;
  response_format: ResponseFormat;
  // Effective threshold, and what it would be by default for this model.
  compact_after_tokens: number;
  compact_after_default: number;
  compact_after_is_default: boolean;
  context_window: number;
  // Code Mode (task 012): the agent's own toggle, the global switch, and whether exec is on.
  code_mode: boolean;
  code_mode_global: boolean;
  code_mode_active: boolean;
  // Sandbox (task 013): the agent's own settings, the global switch, and whether the tools are on.
  sandbox_enabled: boolean;
  sandbox_internet: boolean;
  sandbox_persist: boolean;
  sandbox_global: boolean;
  sandbox_active: boolean;
  // Container image and instance (task 014). container_instance is the effective one.
  container_image: string;
  container_instance: InstanceType;
  container_instance_is_default: boolean;
}

type Row = { agent_id: string; model: string; response_format: ResponseFormat; compact_after_tokens: number | null };

// Default model per tier (SPEC-models 1.1).
export function defaultModelFor(tier: string): string {
  if (tier === "lead") return "@cf/moonshotai/kimi-k2.6";
  if (tier === "operator") return "@cf/moonshotai/kimi-k2.7-code";
  return PRINCIPAL_MODEL;
}

type AgentRow = {
  tier: string;
  code_mode: number;
  sandbox_enabled: number;
  sandbox_internet: number;
  sandbox_persist: number;
  container_image: string;
  container_instance: string | null;
};

async function agentRow(db: D1Database, agentId: string): Promise<AgentRow> {
  const row = await db
    .prepare(
      "SELECT tier, code_mode, sandbox_enabled, sandbox_internet, sandbox_persist, container_image, container_instance FROM agents WHERE id = ?",
    )
    .bind(agentId)
    .first<AgentRow>();
  if (!row) throw new ServiceError("not_found", `Agent ${agentId} not found`, "Check the agent id.", 404);
  return row;
}

type CodeMode = Pick<AgentConfig, "code_mode" | "code_mode_global" | "code_mode_active">;

function codeModeOf(own: boolean, global: boolean): CodeMode {
  return { code_mode: own, code_mode_global: global, code_mode_active: own && global };
}

type SandboxConfig = Pick<
  AgentConfig,
  | "sandbox_enabled"
  | "sandbox_internet"
  | "sandbox_persist"
  | "sandbox_global"
  | "sandbox_active"
  | "container_image"
  | "container_instance"
  | "container_instance_is_default"
>;

type SandboxOwn = { enabled: boolean; internet: boolean; persist: boolean; image: string; instance: string | null };

function sandboxOf(own: SandboxOwn, global: boolean): SandboxConfig {
  return {
    sandbox_enabled: own.enabled,
    sandbox_internet: own.internet,
    sandbox_persist: own.persist,
    sandbox_global: global,
    sandbox_active: own.enabled && global,
    container_image: own.image,
    container_instance: effectiveInstance(own.image, own.instance),
    container_instance_is_default: own.instance === null,
  };
}

function effective(
  agentId: string,
  model: string,
  format: ResponseFormat,
  compact: number | null,
  code: CodeMode,
  sandbox: SandboxConfig,
): AgentConfig {
  const def = defaultCompactAfter(model);
  const window = contextWindowOf(model);
  // A stored threshold that no longer fits the model (model changed) falls back to the default.
  const fits = compact !== null && compact >= COMPACT_MIN_TOKENS && compact <= window * COMPACT_MAX_RATIO;
  return {
    agent_id: agentId,
    model,
    response_format: format,
    compact_after_tokens: fits ? compact! : def,
    compact_after_default: def,
    compact_after_is_default: !fits,
    context_window: window,
    ...code,
    ...sandbox,
  };
}

export async function getAgentConfig(db: D1Database, agentId: string): Promise<AgentConfig> {
  const [agent, settings] = await Promise.all([agentRow(db, agentId), getOrchestratorSettings(db)]);
  const tier = agent.tier;
  const row = await db
    .prepare("SELECT agent_id, model, response_format, compact_after_tokens FROM agent_config WHERE agent_id = ?")
    .bind(agentId)
    .first<Row>();
  const model = row && isMainModel(row.model) ? row.model : defaultModelFor(tier);
  return effective(agentId, model, row?.response_format ?? "markdown", row?.compact_after_tokens ?? null, codeModeOf(agent.code_mode === 1, settings.code_mode_enabled),
    sandboxOf(
      {
        enabled: agent.sandbox_enabled === 1,
        internet: agent.sandbox_internet === 1,
        persist: agent.sandbox_persist === 1,
        image: agent.container_image || "debian",
        instance: agent.container_instance,
      },
      settings.sandbox_global_enabled,
    ),
  );
}

export interface UpdateAgentConfigInput {
  model?: string;
  response_format?: string;
  // number = custom threshold, null = back to the default.
  compact_after_tokens?: number | null;
  code_mode?: boolean;
  sandbox_enabled?: boolean;
  sandbox_internet?: boolean;
  sandbox_persist?: boolean;
  container_image?: string;
  // string = that instance type, null = the image's default.
  container_instance?: string | null;
}

export async function updateAgentConfig(db: D1Database, agentId: string, input: UpdateAgentConfigInput): Promise<AgentConfig> {
  const current = await getAgentConfig(db, agentId);
  const model = input.model ?? current.model;
  const format = input.response_format ?? current.response_format;

  if (!isMainModel(model)) {
    throw new ServiceError("invalid_input", `Unknown model ${model}`, `Use one of: ${MAIN_MODELS.map((m) => m.id).join(", ")}.`);
  }
  if (format !== "markdown" && format !== "plain") {
    throw new ServiceError("invalid_input", `Unknown response format ${format}`, "Use markdown or plain.");
  }

  let compact: number | null = current.compact_after_is_default ? null : current.compact_after_tokens;
  if (input.compact_after_tokens !== undefined) compact = input.compact_after_tokens;
  if (compact !== null) {
    const max = Math.floor(contextWindowOf(model) * COMPACT_MAX_RATIO);
    if (!Number.isInteger(compact) || compact < COMPACT_MIN_TOKENS || compact > max) {
      throw new ServiceError(
        "invalid_input",
        "Compaction threshold out of range",
        `Use ${COMPACT_MIN_TOKENS.toLocaleString("en")} to ${max.toLocaleString("en")} tokens for this model, or reset to the default.`,
      );
    }
  }

  await db
    .prepare(
      `INSERT INTO agent_config (agent_id, model, response_format, compact_after_tokens, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET model = excluded.model, response_format = excluded.response_format,
         compact_after_tokens = excluded.compact_after_tokens, updated_at = excluded.updated_at`,
    )
    .bind(agentId, model, format, compact, new Date().toISOString())
    .run();
  let own = current.code_mode;
  if (typeof input.code_mode === "boolean") {
    own = input.code_mode;
    await db.prepare("UPDATE agents SET code_mode = ? WHERE id = ?").bind(own ? 1 : 0, agentId).run();
  }
  const sandbox: SandboxOwn = {
    enabled: current.sandbox_enabled,
    internet: current.sandbox_internet,
    persist: current.sandbox_persist,
    image: current.container_image,
    instance: current.container_instance_is_default ? null : current.container_instance,
  };
  if (input.container_image !== undefined) {
    checkImageName(input.container_image);
    if (input.container_image !== sandbox.image) {
      sandbox.image = input.container_image;
      // A new image starts from its own default size unless one is given too.
      if (input.container_instance === undefined) sandbox.instance = null;
    }
  }
  if (input.container_instance !== undefined) {
    checkInstance(input.container_instance);
    sandbox.instance = input.container_instance;
  }
  await db
    .prepare("UPDATE agents SET container_image = ?, container_instance = ? WHERE id = ?")
    .bind(sandbox.image, sandbox.instance, agentId)
    .run();
  for (const [key, col] of [
    ["enabled", "sandbox_enabled"],
    ["internet", "sandbox_internet"],
    ["persist", "sandbox_persist"],
  ] as const) {
    const value = input[col];
    if (typeof value !== "boolean") continue;
    sandbox[key] = value;
    await db.prepare(`UPDATE agents SET ${col} = ? WHERE id = ?`).bind(value ? 1 : 0, agentId).run();
  }
  return effective(
    agentId,
    model,
    format as ResponseFormat,
    compact,
    codeModeOf(own, current.code_mode_global),
    sandboxOf(sandbox, current.sandbox_global),
  );
}
