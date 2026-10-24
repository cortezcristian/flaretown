import { type Agent, getAgent } from "../services/agents";
import { getTask } from "../services/tasks";
import { FlaretownAgent, taskPrompt, TIME_RULE } from "./base";

// A Lead: owns an area, reports to the Principal, delegates to its Operators (SPEC-agents 1, 3).
// One Durable Object per Lead, named by its agent id (lead-1, ...).
export class Lead extends FlaretownAgent {
  agentId() {
    return this.name;
  }
  tier() {
    return "lead" as const;
  }

  private me: Agent | null = null;

  // Load this agent's record so the system prompt can use its name and area.
  async loadProfile() {
    if (this.me) return;
    this.me = await getAgent(this.env.DB_CORE, this.agentId());
  }

  getSystemPrompt() {
    const me = this.me ?? { name: this.agentId(), area: "" };
    return `You are ${me.name}, a Lead in Flaretown. You report to the Principal. Your area: ${me.area || "not set"}.
Hierarchy: Principal > Leads (you) > your Operators.

When you get a task:
1. Read it (tasks_get). Decide: do it yourself if it's small, or split it.
2. To split it: see your Operators (agents_list), create one with agents_create (type operator) only if none fits, then create one subtask per piece with tasks_create_subtask (each with its own acceptance criteria). Operators start on them automatically.
3. When an Operator's subtask is in review: read it and its reports (tasks_get, reports_list, reports_read), check the criteria that are met (tasks_check_criterion), then close it (tasks_close) or send it back saying what's missing (tasks_send_back).
4. When all subtasks are done: combine the results into one report on your task (reports_save), comment a summary saying which criteria you believe are met, and move your task to review (tasks_update state: review). You can't close your own task: the Principal checks and closes it.

If you do it yourself: save what you produce with reports_save, comment, and move it to review.
If you can't do something (missing tool or access), say exactly why in a comment and leave the task in progress.

${TIME_RULE}

Never pretend an action happened. Be concise.`;
  }

  // One of this Lead's Operators moved a subtask to review.
  async notifyReview(identifier: string, by: string): Promise<void> {
    await this.loadProfile();
    const task = await getTask(this.env.DB_CORE, identifier);
    await this.say(
      taskPrompt(
        task,
        `Subtask ${task.identifier} is in review, done by ${by}. Check each criterion against its comments and reports (reports_list, reports_read). Check the met ones, then close it or send it back saying what is missing.`,
      ),
    );
  }

  // Every subtask of one of this Lead's tasks is finished.
  async notifySubtasksDone(parentIdentifier: string): Promise<void> {
    await this.loadProfile();
    const task = await getTask(this.env.DB_CORE, parentIdentifier);
    const subs = task.subtasks.map((s) => `- ${s.identifier} (${s.state}, ${s.assignee ?? "unassigned"}): ${s.title}`).join("\n");
    await this.say(
      taskPrompt(
        task,
        `All subtasks of ${task.identifier} are finished:\n${subs}\n\nRead their reports, combine them into one report on ${task.identifier} (reports_save), comment which criteria are met, and move ${task.identifier} to review.`,
      ),
    );
  }
}
