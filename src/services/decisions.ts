// Decision service (task 015, SPEC-decisions 1): agents escalate a call with a description
// (What / Why / How) and evidence. Clef evaluates every Decision; the human decides (manual) or
// Clef does when it's confident enough (system_one). The only place Decision rules live.

import type { Caller } from "./caller";
import { CLEF_LABEL, type ClefModel, type DecisionAnswer, type DecisionQuestion, decide } from "./clef";
import { ServiceError } from "./errors";

export type DecisionStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type EvidenceKind = "text" | "link" | "report" | "artifact" | "command";
export const EVIDENCE_KINDS: EvidenceKind[] = ["text", "link", "report", "artifact", "command"];

export interface Evidence {
  id: string;
  position: number;
  kind: EvidenceKind;
  label: string;
  content: string;
  added_by: string;
  created_at: string;
}

export interface Decision {
  id: string;
  identifier: string;
  title: string;
  description: string;
  task_id: string | null;
  task_identifier: string | null;
  requested_by: string;
  status: DecisionStatus;
  decided_by: string | null;
  decision_comment: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  eval_model: string | null;
  eval_recommendation: "approve" | "reject" | null;
  eval_confidence: number | null;
  eval_urgency: number | null;
  eval_importance: number | null;
  eval_risk: number | null;
  eval_evidence: number | null;
  eval_error: string | null;
  evaluated_at: string | null;
  // Derived
  quadrant: Quadrant | null;
  has_what_why_how: boolean;
}

export type Quadrant = "do_now" | "plan" | "quick_call" | "later";

export interface Evaluation {
  id: string;
  model: string;
  answers: Record<string, DecisionAnswer> | null;
  error: string | null;
  outcome: string | null;
  created_at: string;
}

export interface DecisionDetail extends Decision {
  evidence: Evidence[];
  evaluations: Evaluation[];
  task: { identifier: string; title: string; state: string; criteria: Array<{ position: number; text: string; checked: boolean }> } | null;
}

export interface DecisionSettings {
  mode: "manual" | "system_one";
  model: ClefModel | "off";
  threshold: number;
  auto_reject: boolean;
}

// Scores are 0..3 (four levels); a level of 1.5 or more counts as "high".
const HIGH = 1.5;
// Never auto-approve when risk is critical (top level, score >= 2.5).
export const CRITICAL_RISK = 2.5;

const now = () => new Date().toISOString();

function forbidden(rule: string, hint: string): ServiceError {
  return new ServiceError("forbidden", `Not allowed: ${rule}`, hint, 403);
}

export function requesterName(caller: Caller): string {
  return caller.kind === "agent" ? caller.id : caller.kind === "human" ? "human" : "orchestrator";
}

export function quadrantOf(urgency: number | null, importance: number | null): Quadrant | null {
  if (urgency === null || importance === null) return null;
  const urgent = urgency >= HIGH;
  const important = importance >= HIGH;
  return urgent && important ? "do_now" : important ? "plan" : urgent ? "quick_call" : "later";
}

function hasWhatWhyHow(description: string): boolean {
  return ["what", "why", "how"].every((h) => new RegExp(`^#{1,6}\\s*${h}\\b`, "im").test(description));
}

type DecisionRow = Omit<Decision, "quadrant" | "has_what_why_how">;

function withDerived(row: DecisionRow): Decision {
  return { ...row, quadrant: quadrantOf(row.eval_urgency, row.eval_importance), has_what_why_how: hasWhatWhyHow(row.description) };
}

const SELECT = `SELECT d.*, t.identifier AS task_identifier FROM decisions d LEFT JOIN tasks t ON t.id = d.task_id`;

async function findDecision(db: D1Database, ref: string): Promise<Decision> {
  const row = await db.prepare(`${SELECT} WHERE d.id = ?1 OR d.identifier = ?1`).bind(ref).first<DecisionRow>();
  if (!row) throw new ServiceError("not_found", `Decision ${ref} not found`, "Use its identifier, e.g. DEC-3.", 404);
  return withDerived(row);
}

// ---- settings ------------------------------------------------------------------------------

export async function getDecisionSettings(db: D1Database): Promise<DecisionSettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'decisions_%'")
    .all<{ key: string; value: string }>();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const model = s.decisions_model;
  return {
    mode: s.decisions_mode === "system_one" ? "system_one" : "manual",
    model: model === "clef" || model === "off" ? model : "clef-flash",
    threshold: Number(s.decisions_threshold ?? 0.85),
    auto_reject: s.decisions_auto_reject === "true",
  };
}

export async function updateDecisionSettings(db: D1Database, input: Partial<DecisionSettings>): Promise<DecisionSettings> {
  const next = { ...(await getDecisionSettings(db)), ...input };
  if (next.mode !== "manual" && next.mode !== "system_one") {
    throw new ServiceError("invalid_input", `Unknown mode ${next.mode}`, "Use manual or system_one.");
  }
  if (!["clef", "clef-flash", "off"].includes(next.model)) {
    throw new ServiceError("invalid_input", `Unknown model ${next.model}`, "Use clef, clef-flash or off.");
  }
  if (next.mode === "system_one" && next.model === "off") {
    throw new ServiceError("invalid_input", "System One needs a model", "Pick Clef or Clef Flash, or use Manual.");
  }
  if (!Number.isFinite(next.threshold) || next.threshold < 0.5 || next.threshold > 0.99) {
    throw new ServiceError("invalid_input", "Threshold out of range", "Use 0.50 to 0.99.");
  }
  next.threshold = Math.round(next.threshold * 100) / 100;
  const put = (key: string, value: string) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value);
  await db.batch([
    put("decisions_mode", next.mode),
    put("decisions_model", next.model),
    put("decisions_threshold", String(next.threshold)),
    put("decisions_auto_reject", String(Boolean(next.auto_reject))),
  ]);
  return next;
}

// ---- create / evidence ---------------------------------------------------------------------

export interface EvidenceInput {
  kind?: string;
  label?: string;
  content: string;
}

function cleanEvidence(items: EvidenceInput[] | undefined): Array<{ kind: EvidenceKind; label: string; content: string }> {
  return (items ?? [])
    .map((e) => ({
      kind: (EVIDENCE_KINDS.includes(e.kind as EvidenceKind) ? e.kind : "text") as EvidenceKind,
      label: (e.label ?? "").trim() || (e.kind ?? "evidence"),
      content: (e.content ?? "").trim(),
    }))
    .filter((e) => e.content.length > 0);
}

export interface CreateDecisionInput {
  title: string;
  description: string;
  evidence: EvidenceInput[];
  task?: string;
}

export async function createDecision(db: D1Database, caller: Caller, input: CreateDecisionInput): Promise<DecisionDetail> {
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  const evidence = cleanEvidence(input.evidence);
  if (!title) throw new ServiceError("invalid_input", "Title is required", "One line saying what needs deciding.");
  if (!description) {
    throw new ServiceError("invalid_input", "Description is required", "Write it with three parts: ## What, ## Why, ## How.");
  }
  if (evidence.length === 0) {
    throw new ServiceError("invalid_input", "Evidence is required", "Add at least one item: a report, command output, link or text that supports the proposal.");
  }

  let taskId: string | null = null;
  if (input.task) {
    const task = await db.prepare("SELECT id FROM tasks WHERE id = ?1 OR identifier = ?1").bind(input.task).first<{ id: string }>();
    if (!task) throw new ServiceError("not_found", `Task ${input.task} not found`, "Use the task identifier, e.g. FT-3.", 404);
    taskId = task.id;
  }

  const counter = await db
    .prepare("UPDATE counters SET value = value + 1 WHERE name = 'decision' RETURNING value")
    .first<{ value: number }>();
  if (!counter) throw new ServiceError("internal", "Decision counter missing", "Run the core migrations.", 500);

  const id = crypto.randomUUID();
  const ts = now();
  const by = requesterName(caller);
  await db.batch([
    db
      .prepare(
        `INSERT INTO decisions (id, identifier, title, description, task_id, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, `DEC-${counter.value}`, title, description, taskId, by, ts, ts),
    ...evidence.map((e, i) =>
      db
        .prepare("INSERT INTO decision_evidence (id, decision_id, position, kind, label, content, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, i + 1, e.kind, e.label, e.content, by, ts),
    ),
  ]);
  return getDecision(db, id);
}

export async function addEvidence(db: D1Database, caller: Caller, ref: string, items: EvidenceInput[]): Promise<DecisionDetail> {
  const decision = await findDecision(db, ref);
  if (decision.status !== "pending") {
    throw new ServiceError("invalid_state", `${decision.identifier} is ${decision.status}`, "Evidence can only be added while it's pending.", 409);
  }
  if (caller.kind === "agent" && caller.id !== decision.requested_by && caller.id !== "principal") {
    throw forbidden("only the requesting agent, the Principal or the human can add evidence", `${decision.identifier} was requested by ${decision.requested_by}.`);
  }
  const evidence = cleanEvidence(items);
  if (evidence.length === 0) throw new ServiceError("invalid_input", "No evidence given", "Add at least one item with content.");
  const last = await db
    .prepare("SELECT COALESCE(MAX(position), 0) AS n FROM decision_evidence WHERE decision_id = ?")
    .bind(decision.id)
    .first<{ n: number }>();
  const ts = now();
  const by = requesterName(caller);
  await db.batch([
    ...evidence.map((e, i) =>
      db
        .prepare("INSERT INTO decision_evidence (id, decision_id, position, kind, label, content, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), decision.id, (last?.n ?? 0) + i + 1, e.kind, e.label, e.content, by, ts),
    ),
    db.prepare("UPDATE decisions SET updated_at = ? WHERE id = ?").bind(ts, decision.id),
  ]);
  return getDecision(db, decision.id);
}

// ---- read ----------------------------------------------------------------------------------

export async function getDecision(db: D1Database, ref: string): Promise<DecisionDetail> {
  const decision = await findDecision(db, ref);
  const [evidence, evaluations] = await db.batch([
    db.prepare("SELECT id, position, kind, label, content, added_by, created_at FROM decision_evidence WHERE decision_id = ? ORDER BY position").bind(decision.id),
    db.prepare("SELECT id, model, answers, error, outcome, created_at FROM decision_evaluations WHERE decision_id = ? ORDER BY created_at DESC LIMIT 20").bind(decision.id),
  ]);
  let task: DecisionDetail["task"] = null;
  if (decision.task_id) {
    const t = await db.prepare("SELECT identifier, title, state FROM tasks WHERE id = ?").bind(decision.task_id).first<{ identifier: string; title: string; state: string }>();
    const { results } = await db
      .prepare("SELECT position, text, checked FROM task_criteria WHERE task_id = ? ORDER BY position")
      .bind(decision.task_id)
      .all<{ position: number; text: string; checked: number }>();
    if (t) task = { ...t, criteria: results.map((c) => ({ ...c, checked: Boolean(c.checked) })) };
  }
  return {
    ...decision,
    task,
    evidence: (evidence?.results ?? []) as unknown as Evidence[],
    evaluations: (evaluations?.results ?? []).map((e) => {
      const row = e as { id: string; model: string; answers: string | null; error: string | null; outcome: string | null; created_at: string };
      return { ...row, answers: row.answers ? (JSON.parse(row.answers) as Record<string, DecisionAnswer>) : null };
    }),
  };
}

export interface ListDecisionsInput {
  status?: DecisionStatus | "all";
  agent?: string;
  task?: string;
  decided_by?: "human" | "clef";
}

const QUADRANT_ORDER: Record<Quadrant, number> = { do_now: 0, plan: 1, quick_call: 2, later: 3 };

// Eisenhower order: urgent + important first, then important, then urgent, then the rest;
// inside a quadrant by urgency + importance, then risk, then age. Not evaluated last.
export function eisenhowerSort(list: Decision[]): Decision[] {
  return [...list].sort((a, b) => {
    const qa = a.quadrant ? QUADRANT_ORDER[a.quadrant] : 4;
    const qb = b.quadrant ? QUADRANT_ORDER[b.quadrant] : 4;
    if (qa !== qb) return qa - qb;
    const sa = (a.eval_urgency ?? 0) + (a.eval_importance ?? 0);
    const sb = (b.eval_urgency ?? 0) + (b.eval_importance ?? 0);
    if (sa !== sb) return sb - sa;
    if ((a.eval_risk ?? 0) !== (b.eval_risk ?? 0)) return (b.eval_risk ?? 0) - (a.eval_risk ?? 0);
    return a.created_at.localeCompare(b.created_at);
  });
}

export async function listDecisions(db: D1Database, input: ListDecisionsInput = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const status = input.status ?? "pending";
  if (status !== "all") where.push("d.status = ?"), params.push(status);
  if (input.agent) where.push("d.requested_by = ?"), params.push(input.agent);
  if (input.task) where.push("(t.identifier = ? OR d.task_id = ?)"), params.push(input.task, input.task);
  if (input.decided_by === "human") where.push("d.decided_by = 'human'");
  if (input.decided_by === "clef") where.push("d.decided_by IN ('clef', 'clef-flash')");
  const { results } = await db
    .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at DESC LIMIT 500`)
    .bind(...params)
    .all<DecisionRow>();
  const decisions = results.map(withDerived);
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS all_count,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN status = 'withdrawn' THEN 1 ELSE 0 END) AS withdrawn
       FROM decisions`,
    )
    .first<{ all_count: number; pending: number; approved: number; rejected: number; withdrawn: number }>();
  return {
    decisions: status === "pending" ? eisenhowerSort(decisions) : decisions,
    counts: {
      pending: counts?.pending ?? 0,
      approved: counts?.approved ?? 0,
      rejected: counts?.rejected ?? 0,
      withdrawn: counts?.withdrawn ?? 0,
      all: counts?.all_count ?? 0,
    },
  };
}

export async function pendingCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE status = 'pending'").first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- decide --------------------------------------------------------------------------------

async function setOutcome(
  db: D1Database,
  decision: Decision,
  status: "approved" | "rejected",
  decidedBy: string,
  comment: string | null,
): Promise<DecisionDetail> {
  const ts = now();
  await db
    .prepare("UPDATE decisions SET status = ?, decided_by = ?, decision_comment = ?, decided_at = ?, updated_at = ? WHERE id = ?")
    .bind(status, decidedBy, comment, ts, ts, decision.id)
    .run();
  return getDecision(db, decision.id);
}

// Only the human approves or rejects by hand (agents never decide Decisions in this version).
export async function humanDecide(
  db: D1Database,
  caller: Caller,
  ref: string,
  status: "approved" | "rejected",
  comment?: string,
): Promise<DecisionDetail> {
  if (caller.kind !== "human") throw forbidden("only the human approves or rejects Decisions", "Agents escalate; the human or Clef decides.");
  const decision = await findDecision(db, ref);
  if (decision.status !== "pending") {
    throw new ServiceError("invalid_state", `${decision.identifier} is ${decision.status}`, "Reopen it first to decide again.", 409);
  }
  return setOutcome(db, decision, status, "human", (comment ?? "").trim() || null);
}

export async function withdrawDecision(db: D1Database, caller: Caller, ref: string, reason: string): Promise<DecisionDetail> {
  const decision = await findDecision(db, ref);
  if (decision.status !== "pending") {
    throw new ServiceError("invalid_state", `${decision.identifier} is ${decision.status}`, "Only pending Decisions can be withdrawn.", 409);
  }
  if (caller.kind === "agent" && caller.id !== decision.requested_by) {
    throw forbidden("agents can only withdraw their own Decisions", `${decision.identifier} was requested by ${decision.requested_by}.`);
  }
  const ts = now();
  await db
    .prepare("UPDATE decisions SET status = 'withdrawn', decision_comment = ?, decided_at = ?, updated_at = ? WHERE id = ?")
    .bind((reason ?? "").trim() || null, ts, ts, decision.id)
    .run();
  return getDecision(db, decision.id);
}

// A Decision made by Clef goes back to pending (the human overrides it). Only while its task is open.
export async function reopenDecision(db: D1Database, caller: Caller, ref: string): Promise<DecisionDetail> {
  if (caller.kind !== "human") throw forbidden("only the human reopens Decisions", "");
  const decision = await findDecision(db, ref);
  if (decision.status !== "approved" && decision.status !== "rejected") {
    throw new ServiceError("invalid_state", `${decision.identifier} is ${decision.status}`, "Only approved or rejected Decisions can be reopened.", 409);
  }
  if (decision.task_id) {
    const task = await db.prepare("SELECT state FROM tasks WHERE id = ?").bind(decision.task_id).first<{ state: string }>();
    if (task && (task.state === "done" || task.state === "cancelled")) {
      throw new ServiceError("invalid_state", `Task ${decision.task_identifier} is ${task.state}`, "Its Decisions can't be reopened.", 409);
    }
  }
  const ts = now();
  await db
    .prepare("UPDATE decisions SET status = 'pending', decided_by = NULL, decision_comment = NULL, decided_at = NULL, updated_at = ? WHERE id = ?")
    .bind(ts, decision.id)
    .run();
  return getDecision(db, decision.id);
}

// ---- Clef ----------------------------------------------------------------------------------

function questionsFor(criteria: Array<{ position: number; text: string }>): Record<string, DecisionQuestion> {
  const q: Record<string, DecisionQuestion> = {
    recommendation: {
      type: "choice",
      instructions: "Should this proposal be approved, based on its description (what, why, how) and its evidence?",
      criteria: {
        approve: "The proposal is sound, needed, safe enough, and the evidence supports it.",
        reject: "The proposal is not supported by the evidence, not needed, or unsafe.",
      },
    },
    urgency: {
      type: "score",
      instructions: "How much time pressure is there to decide this?",
      criteria: ["not urgent", "can wait a few days", "should be decided soon", "must be decided now"],
    },
    importance: {
      type: "score",
      instructions: "How much does this decision affect the goals of the work?",
      criteria: ["trivial", "minor", "significant", "critical"],
    },
    risk: {
      type: "score",
      instructions: "How risky is carrying out the proposal (cost, irreversibility, blast radius)?",
      criteria: ["low", "medium", "high", "critical"],
    },
    evidence: {
      type: "score",
      instructions: "How well does the evidence support the proposal?",
      criteria: ["missing", "weak", "adequate", "strong"],
    },
  };
  for (const c of criteria) {
    q[`criterion.${c.position}`] = {
      type: "bool",
      instructions: `Does the evidence show this acceptance criterion of the linked task is met: "${c.text}"?`,
      criteria: { true: "The evidence shows it is met.", false: "It is not met, or the evidence doesn't show it." },
    };
  }
  return q;
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

export type EvaluationOutcome = "approved" | "rejected" | "unsure" | "critical_risk" | "manual" | "error" | "skipped";

export interface EvaluateResult {
  decision: DecisionDetail;
  outcome: EvaluationOutcome;
  autoDecided: boolean;
}

// Ask Clef about a pending Decision, store the run, and in System One decide when confident.
export async function evaluateDecision(env: Env, ref: string): Promise<EvaluateResult> {
  const db = env.DB_CORE;
  const settings = await getDecisionSettings(db);
  const detail = await getDecision(db, ref);
  if (settings.model === "off") return { decision: detail, outcome: "skipped", autoDecided: false };
  if (detail.status !== "pending") return { decision: detail, outcome: "skipped", autoDecided: false };

  const agent = await db
    .prepare("SELECT id, name, tier, area FROM agents WHERE id = ?")
    .bind(detail.requested_by)
    .first<{ id: string; name: string; tier: string; area: string }>();
  const taskRow = detail.task_id
    ? await db.prepare("SELECT identifier, title, description FROM tasks WHERE id = ?").bind(detail.task_id).first<{ identifier: string; title: string; description: string }>()
    : null;
  const criteria = detail.task?.criteria ?? [];
  const state = {
    decision: { id: detail.identifier, title: detail.title, description: trim(detail.description, 20_000) },
    evidence: detail.evidence.map((e) => ({ kind: e.kind, label: e.label, content: trim(e.content, 20_000) })),
    task: taskRow ? { ...taskRow, description: trim(taskRow.description, 10_000), criteria: criteria.map((c) => c.text) } : null,
    requested_by: agent ? { name: agent.name, tier: agent.tier, area: agent.area } : { name: detail.requested_by },
  };

  const model = settings.model;
  const ts = now();
  let answers: Record<string, DecisionAnswer>;
  let usage: unknown = null;
  try {
    const result = await decide(env, model, state, questionsFor(criteria));
    answers = result.answers;
    usage = result.usage;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.batch([
      db
        .prepare("INSERT INTO decision_evaluations (id, decision_id, model, error, outcome, created_at) VALUES (?, ?, ?, ?, 'error', ?)")
        .bind(crypto.randomUUID(), detail.id, model, message, ts),
      db.prepare("UPDATE decisions SET eval_model = ?, eval_error = ?, evaluated_at = ?, updated_at = ? WHERE id = ?").bind(model, message, ts, ts, detail.id),
    ]);
    return { decision: await getDecision(db, detail.id), outcome: "error", autoDecided: false };
  }

  const rec = answers.recommendation as Extract<DecisionAnswer, { type: "choice" }>;
  const score = (k: string) => (answers[k] as Extract<DecisionAnswer, { type: "score" }>).score;
  const risk = score("risk");

  let outcome: EvaluationOutcome = "manual";
  if (settings.mode === "system_one") {
    if (rec.choice === "approve" && risk >= CRITICAL_RISK) outcome = "critical_risk";
    else if (rec.confidence < settings.threshold) outcome = "unsure";
    else if (rec.choice === "approve") outcome = "approved";
    else outcome = settings.auto_reject ? "rejected" : "unsure";
  }

  await db.batch([
    db
      .prepare("INSERT INTO decision_evaluations (id, decision_id, model, answers, usage, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), detail.id, model, JSON.stringify(answers), usage ? JSON.stringify(usage) : null, outcome, ts),
    db
      .prepare(
        `UPDATE decisions SET eval_model = ?, eval_recommendation = ?, eval_confidence = ?, eval_urgency = ?, eval_importance = ?,
           eval_risk = ?, eval_evidence = ?, eval_error = NULL, evaluated_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(model, rec.choice, rec.confidence, score("urgency"), score("importance"), risk, score("evidence"), ts, ts, detail.id),
  ]);

  if (outcome === "approved" || outcome === "rejected") {
    const comment = `${CLEF_LABEL[model]}: ${rec.choice} at ${rec.confidence.toFixed(2)} confidence (threshold ${settings.threshold.toFixed(2)}).`;
    const decided = await setOutcome(db, await findDecision(db, detail.id), outcome, model, comment);
    return { decision: decided, outcome, autoDecided: true };
  }
  return { decision: await getDecision(db, detail.id), outcome, autoDecided: false };
}

// ---- tasks that require approval -----------------------------------------------------------

export async function hasApprovedDecision(db: D1Database, taskId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM decisions WHERE task_id = ? AND status = 'approved'")
    .bind(taskId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}
