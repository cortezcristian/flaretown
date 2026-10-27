// Clef and Clef Flash: Workers AI decision models (SPEC-models 2). Given a JSON state and typed
// questions they return a probability for every allowed answer. Contract from
// references/cloudflare-os/plans/decision-models.md.

import { ServiceError } from "./errors";

export type ClefModel = "clef" | "clef-flash";
export const CLEF_IDS: Record<ClefModel, string> = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
};
export const CLEF_LABEL: Record<ClefModel, string> = { clef: "Clef", "clef-flash": "Clef Flash" };

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };

export interface ClefResult {
  model: ClefModel;
  answers: Record<string, DecisionAnswer>;
  usage: unknown;
}

// About 4 characters per token; leave room for the questions under the 65,536-token context.
export const MAX_STATE_CHARS = 200_000;

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Every question gets exactly one answer of its type, or the whole response is rejected.
function validate(questions: Record<string, DecisionQuestion>, raw: Record<string, unknown>): Record<string, DecisionAnswer> {
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = raw[key] as any;
    if (!a || typeof a !== "object") throw new Error(`No answer for ${key}`);
    const type = a.type ?? q.type;
    if (type !== q.type) throw new Error(`Answer for ${key} is ${type}, expected ${q.type}`);
    if (q.type === "choice") {
      if (!(a.choice in q.criteria) || !num(a.confidence) || typeof a.probabilities !== "object") throw new Error(`Bad choice answer for ${key}`);
      out[key] = { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
    } else if (q.type === "score") {
      if (!num(a.score) || !num(a.confidence)) throw new Error(`Bad score answer for ${key}`);
      out[key] = { type: "score", score: a.score, confidence: a.confidence };
    } else {
      if (!num(a.probability)) throw new Error(`Bad bool answer for ${key}`);
      out[key] = { type: "bool", probability: a.probability };
    }
  }
  return out;
}

export async function decide(
  env: Env,
  model: ClefModel,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
): Promise<ClefResult> {
  if (JSON.stringify(state).length > MAX_STATE_CHARS) {
    throw new ServiceError("invalid_input", "Decision state is too large for Clef", "Trim the evidence (65,536-token context).");
  }
  // The binding's types don't list the decision models yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await (env.AI as any).run(CLEF_IDS[model], { state, questions })) as any;
  // Accept { answers }, { result: { answers } } or the answers record itself.
  const raw = res?.answers ?? res?.result?.answers ?? res;
  if (!raw || typeof raw !== "object") throw new Error("Empty response from Clef");
  return { model, answers: validate(questions, raw), usage: res?.usage ?? res?.result?.usage ?? null };
}
