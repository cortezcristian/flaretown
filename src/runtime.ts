// Cross-agent plumbing: reach an agent's Durable Object by agent id, poke the Orchestrator,
// and the side effects that follow task changes (SPEC-agents section 3, SPEC-orchestrator 6).

import { waitUntil } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { evaluateDecision } from "./services/decisions";

export const PRINCIPAL_INSTANCE = "default";

// The methods every agent class exposes over RPC.
export interface AgentRpc {
  say(text: string): Promise<void>;
  runTask(identifier: string): Promise<void>;
  notifyReview(identifier: string, by: string): Promise<void>;
  notifySubtasksDone(parentIdentifier: string): Promise<void>;
  applyConfig(): Promise<void>;
  compactNow(): Promise<{ compacted: boolean }>;
  sandboxStatus(): Promise<unknown>;
  sandboxRestart(): Promise<unknown>;
  sandboxReset(): Promise<unknown>;
  containerImages(): Promise<Array<{ name: string; description: string; default_instance: string; desktop: boolean }>>;
  containerBoot(): Promise<{ ok: boolean; error?: string }>;
  containerStop(): Promise<unknown>;
  containerResetProfile(): Promise<unknown>;
  containerChanged(imageChanged: boolean): Promise<unknown>;
}

export async function agentStub(env: Env, agentId: string): Promise<AgentRpc> {
  if (agentId === "principal") {
    return (await getAgentByName(env.PRINCIPAL, PRINCIPAL_INSTANCE)) as unknown as AgentRpc;
  }
  const row = await env.DB_CORE.prepare("SELECT tier FROM agents WHERE id = ?").bind(agentId).first<{ tier: string }>();
  if (row?.tier === "lead") return (await getAgentByName(env.LEAD, agentId)) as unknown as AgentRpc;
  if (row?.tier === "operator") return (await getAgentByName(env.OPERATOR, agentId)) as unknown as AgentRpc;
  throw new Error(`No agent ${agentId}`);
}

// The chat endpoint of an agent: the Durable Object that serves /api/agents/<id>/chat.
export async function agentChatStub(env: Env, agentId: string): Promise<{ fetch(req: Request): Promise<Response> } | null> {
  if (agentId === "principal") return getAgentByName(env.PRINCIPAL, PRINCIPAL_INSTANCE);
  const row = await env.DB_CORE.prepare("SELECT tier FROM agents WHERE id = ?").bind(agentId).first<{ tier: string }>();
  if (row?.tier === "lead") return getAgentByName(env.LEAD, agentId);
  if (row?.tier === "operator") return getAgentByName(env.OPERATOR, agentId);
  return null;
}

export function schedulerStub(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName("default"));
}

// Routines changed: re-arm the scheduler's alarm.
export function rescheduleRoutines(env: Env) {
  background(schedulerStub(env).reschedule(), "scheduler reschedule failed");
}

export function orchestratorStub(env: Env) {
  return env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName("default"));
}

function background(promise: Promise<unknown>, label: string) {
  waitUntil(promise.catch((err) => console.error(label, err)));
}

// A task was created or assigned: let the Orchestrator dispatch without waiting for the tick.
export function pokeOrchestrator(env: Env) {
  background(orchestratorStub(env).poke(), "orchestrator poke failed");
}

// Start the task's agent on it (task already claimed).
export function startAgentOnTask(env: Env, agentId: string, identifier: string) {
  background(
    agentStub(env, agentId).then((a) => a.runTask(identifier)),
    `start ${agentId} on ${identifier} failed`,
  );
}

// A task moved to review. Subtasks are reviewed by the Lead of the parent task; top-level
// tasks by the Principal (SPEC-agents section 3).
export function notifyReviewer(env: Env, task: { identifier: string; parent_id: string | null }, by: string) {
  background(
    (async () => {
      let reviewer = "principal";
      if (task.parent_id) {
        const parent = await env.DB_CORE.prepare("SELECT assignee FROM tasks WHERE id = ?").bind(task.parent_id).first<{ assignee: string | null }>();
        reviewer = parent?.assignee ?? "principal";
      }
      await (await agentStub(env, reviewer)).notifyReview(task.identifier, by);
    })(),
    `notify review of ${task.identifier} failed`,
  );
}

// A subtask finished (done or cancelled). If it was the last open one, tell the parent's Lead.
export function afterSubtaskFinished(env: Env, task: { parent_id: string | null }) {
  if (!task.parent_id) return;
  background(
    (async () => {
      const parent = await env.DB_CORE.prepare(
        `SELECT identifier, assignee, state,
           (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = p.id AND c.state NOT IN ('done', 'cancelled')) AS open
         FROM tasks p WHERE p.id = ?`,
      )
        .bind(task.parent_id)
        .first<{ identifier: string; assignee: string | null; state: string; open: number }>();
      if (!parent || parent.open > 0 || !parent.assignee || !["todo", "in_progress"].includes(parent.state)) return;
      await (await agentStub(env, parent.assignee)).notifySubtasksDone(parent.identifier);
    })(),
    "notify subtasks done failed",
  );
}

// ---- Decisions (task 015) -------------------------------------------------------------------

type DecidedDecision = {
  identifier: string;
  title: string;
  description: string;
  requested_by: string;
  status: string;
  decided_by: string | null;
  decision_comment: string | null;
  task_identifier: string | null;
};

// Tell the requesting agent how its Decision ended, in its chat, so it can act on it.
export function notifyDecision(env: Env, decision: DecidedDecision) {
  if (decision.requested_by === "human" || decision.requested_by === "orchestrator") return;
  const who = decision.decided_by === "human" ? "the human" : decision.decided_by ?? "someone";
  const verdict = decision.status === "approved" ? "APPROVED" : decision.status === "rejected" ? "REJECTED" : decision.status.toUpperCase();
  const next =
    decision.status === "approved"
      ? "Go ahead with it as proposed (the How below)."
      : decision.status === "rejected"
        ? "Don't do it. Adjust the plan, or stop and explain on the task."
        : "It's back to pending: wait for a new outcome before acting.";
  const text =
    `Decision ${decision.identifier} "${decision.title}" was ${verdict} by ${who}.` +
    `${decision.decision_comment ? `\nComment: ${decision.decision_comment}` : ""}` +
    `${decision.task_identifier ? `\nTask: ${decision.task_identifier}` : ""}\n${next}\n\n${decision.description}`;
  background(
    agentStub(env, decision.requested_by).then((a) => a.say(text)),
    `notify ${decision.requested_by} of ${decision.identifier} failed`,
  );
}

// Run Clef on a Decision in the background; in System One it may decide, then tell the agent.
export function evaluateDecisionInBackground(env: Env, ref: string) {
  background(
    (async () => {
      const result = await evaluateDecision(env, ref);
      if (result.autoDecided) notifyDecision(env, result.decision);
    })(),
    `evaluate decision ${ref} failed`,
  );
}

