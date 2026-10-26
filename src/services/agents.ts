// Agent service: the hierarchy rules (SPEC-agents sections 1, 2, 5).
// Principal > Lead > Operator. The Principal can never be retired.

import { isMainModel, MAIN_MODELS } from "../models";
import { type Caller, callerName, isHumanOrPrincipal } from "./caller";
import { ServiceError } from "./errors";
import { defaultModelFor } from "./agentConfig";
import { checkImageName, checkInstance } from "./containers";
import { getOrchestratorSettings } from "./settings";

export type Tier = "principal" | "lead" | "operator";

export interface Agent {
  id: string;
  name: string;
  tier: Tier;
  parent_id: string | null;
  area: string;
  status: "active" | "retired";
  created_by: string;
  created_at: string;
  retired_at: string | null;
  // 1 = the agent gets exec when the global Code Mode switch is on (task 012).
  code_mode: number;
  // Sandbox (task 013): 1 = on. sandbox_last_used_at NULL = no container running.
  sandbox_enabled: number;
  sandbox_internet: number;
  sandbox_persist: number;
  sandbox_last_used_at: string | null;
  container_image: string;
  container_instance: string | null;
}

export interface AgentSummary extends Agent {
  model: string;
  open_tasks: number;
}

// Max Leads and Operators per Lead are settings (Settings → Agents, src/services/settings.ts).

function forbidden(rule: string, hint: string) {
  return new ServiceError("forbidden", `Not allowed: ${rule}`, hint, 403);
}

export async function getAgent(db: D1Database, id: string): Promise<Agent> {
  const agent = await db.prepare("SELECT * FROM agents WHERE id = ?1 OR name = ?1").bind(id).first<Agent>();
  if (!agent) throw new ServiceError("not_found", `Agent ${id} not found`, "Use the agent id (e.g. lead-1) or its name.", 404);
  return agent;
}

export async function listAgents(db: D1Database, opts: { includeRetired?: boolean } = {}): Promise<AgentSummary[]> {
  const where = opts.includeRetired ? "" : "WHERE a.status = 'active'";
  const { results } = await db
    .prepare(
      `SELECT a.*,
         COALESCE(c.model, '') AS model,
         (SELECT COUNT(*) FROM tasks t WHERE t.assignee = a.id AND t.state IN ('todo', 'in_progress', 'review')) AS open_tasks
       FROM agents a LEFT JOIN agent_config c ON c.agent_id = a.id
       ${where}
       ORDER BY CASE a.tier WHEN 'principal' THEN 0 WHEN 'lead' THEN 1 ELSE 2 END, a.created_at`,
    )
    .all<AgentSummary>();
  return results.map((a) => ({ ...a, model: a.model || defaultModelFor(a.tier) }));
}

export interface CreateAgentInput {
  name: string;
  type: string;
  parent_id?: string;
  area?: string;
  model?: string;
  // Default: on for Operators, off for Leads (SPEC-agents).
  code_mode?: boolean;
  // Sandbox: all off by default.
  sandbox_enabled?: boolean;
  sandbox_internet?: boolean;
  sandbox_persist?: boolean;
  // Container image (debian, desktop or custom) and instance type (default: the image's).
  container_image?: string;
  container_instance?: string;
}

// A Lead may create and delete Operators under itself only (SPEC-agents section 5).
async function leadCaller(db: D1Database, caller: Caller): Promise<string | null> {
  if (caller.kind !== "agent") return null;
  const row = await db.prepare("SELECT tier FROM agents WHERE id = ? AND status = 'active'").bind(caller.id).first<{ tier: string }>();
  return row?.tier === "lead" ? caller.id : null;
}

export async function createAgent(db: D1Database, caller: Caller, input: CreateAgentInput): Promise<AgentSummary> {
  const asLead = isHumanOrPrincipal(caller) ? null : await leadCaller(db, caller);
  if (!isHumanOrPrincipal(caller) && !asLead) {
    throw forbidden("only the Principal, the human, or a Lead (for its own Operators) can create agents", "SPEC-agents section 5.");
  }
  if (asLead) {
    if (input.type !== "operator") throw forbidden("a Lead can only create Operators", "Leads are created by the Principal or the human.");
    if (input.parent_id && input.parent_id !== asLead) throw forbidden("a Lead can only create Operators under itself", "Leave parent_id empty.");
    input = { ...input, parent_id: asLead };
  }
  const name = (input.name ?? "").trim();
  if (!name) throw new ServiceError("invalid_input", "Name is required", "Give the agent a short name.");
  const type = input.type as Tier;
  if (type !== "lead" && type !== "operator") {
    throw new ServiceError("invalid_input", `Unknown type ${input.type}`, "Type is lead or operator. There is only one Principal.");
  }
  const exists = await db.prepare("SELECT id FROM agents WHERE name = ?").bind(name).first();
  if (exists) throw new ServiceError("conflict", `An agent named ${name} already exists`, "Pick another name.", 409);

  const limits = await getOrchestratorSettings(db);
  let parentId: string;
  if (type === "lead") {
    // A Lead always reports to the Principal.
    if (input.parent_id && input.parent_id !== "principal") {
      throw forbidden("a Lead always reports to the Principal", "Leave the parent empty for a Lead.");
    }
    const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM agents WHERE tier = 'lead' AND status = 'active'").first<{ n: number }>())!;
    if (n >= limits.agents_max_leads) {
      throw forbidden(`max ${limits.agents_max_leads} Leads`, "Retire a Lead first, or raise Max Leads in Settings.");
    }
    parentId = "principal";
  } else {
    if (!input.parent_id) throw forbidden("an Operator must be under a Lead", "Choose the Lead it reports to.");
    const parent = await getAgent(db, input.parent_id);
    if (parent.tier !== "lead" || parent.status !== "active") {
      throw forbidden("an Operator's parent must be an active Lead", `${parent.name} is a ${parent.tier}${parent.status === "retired" ? " (retired)" : ""}.`);
    }
    const { n } = (await db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE parent_id = ? AND status = 'active'")
      .bind(parent.id)
      .first<{ n: number }>())!;
    if (n >= limits.agents_max_operators_per_lead) {
      throw forbidden(`max ${limits.agents_max_operators_per_lead} Operators per Lead`, `${parent.name} is full. Retire one, or raise the limit in Settings.`);
    }
    parentId = parent.id;
  }

  if (input.container_image) checkImageName(input.container_image);
  if (input.container_instance) checkInstance(input.container_instance);

  const model = input.model || defaultModelFor(type);
  if (!isMainModel(model)) {
    throw new ServiceError("invalid_input", `Unknown model ${model}`, `Use one of: ${MAIN_MODELS.map((m) => m.id).join(", ")}.`);
  }

  const counter = await db
    .prepare("UPDATE counters SET value = value + 1 WHERE name = 'agent' RETURNING value")
    .first<{ value: number }>();
  if (!counter) throw new ServiceError("internal", "Agent counter missing", "Run the core migrations.", 500);
  const id = `${type}-${counter.value}`;
  const ts = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT INTO agents (id, name, tier, parent_id, area, created_by, created_at, code_mode, sandbox_enabled, sandbox_internet,
           sandbox_persist, container_image, container_instance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        name,
        type,
        parentId,
        (input.area ?? "").trim(),
        callerName(caller),
        ts,
        (input.code_mode ?? type === "operator") ? 1 : 0,
        input.sandbox_enabled ? 1 : 0,
        input.sandbox_internet ? 1 : 0,
        input.sandbox_persist ? 1 : 0,
        input.container_image || "debian",
        input.container_instance || null,
      ),
    db
      .prepare("INSERT INTO agent_config (agent_id, model, response_format, updated_at) VALUES (?, ?, 'markdown', ?)")
      .bind(id, model, ts),
  ]);

  return (await listAgents(db)).find((a) => a.id === id)!;
}

// Soft delete. Open tasks go back to the parent (SPEC-agents 5.2).
export async function retireAgent(db: D1Database, caller: Caller, id: string): Promise<Agent> {
  const asLead = isHumanOrPrincipal(caller) ? null : await leadCaller(db, caller);
  if (!isHumanOrPrincipal(caller) && !asLead) {
    throw forbidden("only the Principal, the human, or a Lead (for its own Operators) can delete agents", "SPEC-agents section 5.");
  }
  const agent = await getAgent(db, id);
  if (asLead && (agent.tier !== "operator" || agent.parent_id !== asLead)) {
    throw forbidden("a Lead can only delete its own Operators", `${agent.name} is not one of yours.`);
  }
  if (agent.tier === "principal") {
    throw forbidden("the Principal can never be deleted", "It is the agent in charge of the instance.");
  }
  if (agent.status === "retired") {
    throw new ServiceError("invalid_state", `${agent.name} is already deleted`, "Nothing to do.", 409);
  }
  if (agent.tier === "lead") {
    const { n } = (await db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE parent_id = ? AND status = 'active'")
      .bind(agent.id)
      .first<{ n: number }>())!;
    if (n > 0) {
      throw forbidden(`${agent.name} still has ${n} active Operator(s)`, "Delete or move its Operators first.");
    }
  }
  const ts = new Date().toISOString();
  const parent = agent.parent_id ?? "principal";
  await db.batch([
    db.prepare("UPDATE agents SET status = 'retired', retired_at = ? WHERE id = ?").bind(ts, agent.id),
    db.prepare("DELETE FROM agent_skills WHERE agent_id = ?").bind(agent.id),
    // Its MCP attachments go too (the retired DO is never woken again).
    db.prepare("DELETE FROM agent_mcps WHERE agent_id = ?").bind(agent.id),
    // Projects it owned have no owner now.
    db.prepare("UPDATE projects SET owner_id = NULL WHERE owner_id = ?").bind(agent.id),
    // Retiring an agent disables its routines (SPEC-agents 7.2).
    db.prepare("UPDATE routines SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE owner_id = ?").bind(ts, agent.id),
    // Running work goes back to the queue under the parent; review stays in review.
    db
      .prepare(
        `UPDATE tasks SET assignee = ?, state = CASE WHEN state = 'in_progress' THEN 'todo' ELSE state END, updated_at = ?
         WHERE assignee = ? AND state IN ('todo', 'in_progress', 'review')`,
      )
      .bind(parent, ts, agent.id),
  ]);
  return getAgent(db, agent.id);
}
