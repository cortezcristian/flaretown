// REST for the Decisions section (task 015, SPEC-decisions 1). The human decides here; agents
// request Decisions through their tools (same service functions).

import { evaluateDecisionInBackground, notifyDecision } from "../runtime";
import { HUMAN } from "../services/caller";
import {
  addEvidence,
  createDecision,
  type DecisionStatus,
  evaluateDecision,
  getDecision,
  getDecisionSettings,
  humanDecide,
  listDecisions,
  reopenDecision,
  updateDecisionSettings,
  withdrawDecision,
} from "../services/decisions";
import { ServiceError } from "../services/errors";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const methodNotAllowed = () => json({ error: "Method not allowed", code: "method_not_allowed", hint: "Check the method." }, 405);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export async function handleDecisionsApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/decisions")) return null;
  const db = env.DB_CORE;
  const method = request.method;
  try {
    if (pathname === "/api/decisions/settings") {
      if (method === "GET") return json(await getDecisionSettings(db));
      if (method === "PATCH") {
        const b = await readJson(request);
        return json(
          await updateDecisionSettings(db, {
            ...(b.mode !== undefined ? { mode: b.mode as "manual" | "system_one" } : {}),
            ...(b.model !== undefined ? { model: b.model as "clef" | "clef-flash" | "off" } : {}),
            ...(b.threshold !== undefined ? { threshold: Number(b.threshold) } : {}),
            ...(typeof b.auto_reject === "boolean" ? { auto_reject: b.auto_reject } : {}),
          }),
        );
      }
      return methodNotAllowed();
    }

    if (pathname === "/api/decisions") {
      if (method === "GET") {
        const q = new URL(request.url).searchParams;
        const decidedBy = q.get("decided_by");
        const result = await listDecisions(db, {
          status: (q.get("status") as DecisionStatus | "all" | null) ?? "pending",
          agent: q.get("agent") ?? undefined,
          task: q.get("task") ?? undefined,
          decided_by: decidedBy === "human" || decidedBy === "clef" ? decidedBy : undefined,
        });
        return json({ ...result, settings: await getDecisionSettings(db) });
      }
      if (method === "POST") {
        const b = await readJson(request);
        const decision = await createDecision(db, HUMAN, {
          title: str(b.title) ?? "",
          description: str(b.description) ?? "",
          evidence: Array.isArray(b.evidence) ? (b.evidence as never) : [],
          task: str(b.task),
        });
        evaluateDecisionInBackground(env, decision.id);
        return json(decision, 201);
      }
      return methodNotAllowed();
    }

    const m = pathname.match(/^\/api\/decisions\/([A-Za-z0-9-]+)(?:\/(evidence|approve|reject|reopen|evaluate|withdraw))?$/);
    if (!m) return json({ error: "Not found", code: "not_found", hint: "Unknown decisions route." }, 404);
    const [, ref, action] = m as unknown as [string, string, string | undefined];

    if (!action) {
      if (method !== "GET") return methodNotAllowed();
      return json(await getDecision(db, ref));
    }
    if (method !== "POST") return methodNotAllowed();
    const b = await readJson(request);

    if (action === "evidence") {
      const decision = await addEvidence(db, HUMAN, ref, Array.isArray(b.evidence) ? (b.evidence as never) : []);
      evaluateDecisionInBackground(env, decision.id);
      return json(decision);
    }
    if (action === "approve" || action === "reject") {
      const decision = await humanDecide(db, HUMAN, ref, action === "approve" ? "approved" : "rejected", str(b.comment));
      notifyDecision(env, decision);
      return json(decision);
    }
    if (action === "reopen") {
      const decision = await reopenDecision(db, HUMAN, ref);
      notifyDecision(env, decision);
      return json(decision);
    }
    if (action === "withdraw") return json(await withdrawDecision(db, HUMAN, ref, str(b.reason) ?? ""));
    // evaluate: run Clef now and return the result (the panel waits for it).
    const result = await evaluateDecision(env, ref);
    if (result.autoDecided) notifyDecision(env, result.decision);
    return json({ ...result.decision, outcome: result.outcome });
  } catch (err) {
    if (err instanceof ServiceError) return json(err.toJSON(), err.status);
    console.error("decisions api error", err);
    return json({ error: "Internal error", code: "internal", hint: "Check the Worker logs." }, 500);
  }
}
