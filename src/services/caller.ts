// Who is calling the service layer. Every permission check uses this (SPEC-api 1.2).
// "system" is the Orchestrator.
export type Caller = { kind: "human" } | { kind: "agent"; id: string } | { kind: "system" };

export const HUMAN: Caller = { kind: "human" };
export const PRINCIPAL: Caller = { kind: "agent", id: "principal" };
export const SYSTEM: Caller = { kind: "system" };

export function agentCaller(id: string): Caller {
  return { kind: "agent", id };
}

export function callerName(caller: Caller): string {
  if (caller.kind === "human") return "human";
  if (caller.kind === "system") return "orchestrator";
  return `agent:${caller.id}`;
}

export function isPrincipal(caller: Caller): boolean {
  return caller.kind === "agent" && caller.id === "principal";
}

export function isHumanOrPrincipal(caller: Caller): boolean {
  return caller.kind === "human" || isPrincipal(caller);
}
