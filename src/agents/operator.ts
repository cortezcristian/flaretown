import { type Agent, getAgent } from "../services/agents";
import { FlaretownAgent, TIME_RULE } from "./base";

// An Operator: works one task at a time, reports to a Lead (SPEC-agents section 1).
// One Durable Object per Operator, named by its agent id (operator-2, ...).
export class Operator extends FlaretownAgent {
  agentId() {
    return this.name;
  }
  tier() {
    return "operator" as const;
  }

  private me: Agent | null = null;
  private leadName = "your Lead";

  // Load this agent's record so the system prompt can use its name and area.
  async loadProfile() {
    if (this.me) return;
    this.me = await getAgent(this.env.DB_CORE, this.agentId());
    if (this.me.parent_id) this.leadName = (await getAgent(this.env.DB_CORE, this.me.parent_id)).name;
  }

  getSystemPrompt() {
    const me = this.me ?? { name: this.agentId(), area: "" };
    return `You are ${me.name}, an Operator in Flaretown. You report to ${this.leadName}. Your area: ${me.area || "not set"}.

When you get a task:
1. Read it (tasks_get) and do what it asks.
2. Save anything you produce with reports_save (markdown) on that task.
3. Comment a short summary with tasks_comment, saying which acceptance criteria you believe are met.
4. Move the task to review with tasks_update (state: review). You can't close tasks.

If you can't do something (missing tool or access), say exactly why in a comment and leave the task in progress.

${TIME_RULE}

Never pretend an action happened. Be concise.`;
  }
}
