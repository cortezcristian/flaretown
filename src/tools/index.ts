// Tool definitions: one per tool, shared by the platform MCP server (/mcp/agents) and the
// agents' Think tools. Each calls the same service function as its REST endpoint (SPEC-api 2.2).

import { z } from "zod";
import {
  afterSubtaskFinished,
  evaluateDecisionInBackground,
  notifyReviewer,
  pokeOrchestrator,
  rescheduleRoutines,
  schedulerStub,
  startAgentOnTask,
} from "../runtime";
import { createRoutine, deleteRoutine, listRoutines, requireCanRun, updateRoutine } from "../services/routines";
import { createAgent, listAgents, retireAgent } from "../services/agents";
import { listReports, readReport, saveReport } from "../services/artifacts";
import { commitFiles, ensureAgentRepo, repoFile, repoTree } from "../services/repos";
import type { Caller } from "../services/caller";
import { getTimezone } from "../services/settings";
import { addEvidence, createDecision, getDecision, listDecisions, withdrawDecision } from "../services/decisions";
import { listSkills, setAgentSkills } from "../services/skills";
import { attachServer, detachServer, listForAgents } from "../services/mcps";
import { createProject, getProject, listProjects, setProjectStatus, updateProject } from "../services/projects";
import {
  cancelTask,
  checkCriterion,
  closeTask,
  commentTask,
  createSubtask,
  createTask,
  getTask,
  listTasks,
  sendBackTask,
  updateTask,
} from "../services/tasks";

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run: (env: Env, caller: Caller, args: z.infer<S>) => Promise<unknown>;
}

function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

const taskRef = z.string().describe("Task id or identifier, e.g. FT-3");

export const allTools: ToolDef[] = [
  // ---- tasks ----
  defineTool({
    name: "tasks_create",
    description:
      "Open a new task. Always include acceptance criteria: short checks of what must be true for the task to be done. Assign it to an agent id (see agents_list) or leave it for yourself.",
    input: z.object({
      description: z.string().describe("What the task is about"),
      title: z.string().optional().describe("Short title. Defaults to the first line of the description"),
      criteria: z.array(z.string()).describe("Acceptance criteria, one short check per item"),
      assignee: z.string().optional().describe("Agent id, e.g. lead-1"),
      priority: z.number().int().min(1).max(4).optional().describe("1 = highest"),
      parent_id: z.string().optional().describe("Parent task id or identifier, for subtasks"),
      project_id: z.string().optional().describe("Project id (projects_list). Subtasks default to the parent's project, other tasks to 'default'"),
      requires_approval: z.boolean().optional().describe("The task can't go to review or close without an approved Decision"),
    }),
    run: async (env, caller, args) => {
      const task = await createTask(env.DB_CORE, caller, args);
      pokeOrchestrator(env);
      return task;
    },
  }),
  defineTool({
    name: "tasks_list",
    description: "List tasks. filter: open (default), done or all. assignee: an agent id.",
    input: z.object({
      filter: z.enum(["open", "done", "all"]).optional(),
      assignee: z.string().optional(),
      project_id: z.string().optional(),
    }),
    run: (env, _caller, args) => listTasks(env.DB_CORE, args),
  }),
  defineTool({
    name: "tasks_get",
    description: "Get one task with its acceptance criteria and comments.",
    input: z.object({ task: taskRef }),
    run: (env, _caller, args) => getTask(env.DB_CORE, args.task),
  }),
  defineTool({
    name: "tasks_update",
    description:
      "Update a task's title, description or state (in_progress, review). Move your task to review when you believe its criteria are met. Use tasks_close or tasks_cancel to finish a task.",
    input: z.object({
      task: taskRef,
      title: z.string().optional(),
      description: z.string().optional(),
      state: z.enum(["todo", "in_progress", "review"]).optional(),
      assignee: z.string().optional().describe("Agent id. Principal only"),
      priority: z.number().int().min(1).max(4).optional().describe("Principal only"),
      requires_approval: z.boolean().optional().describe("Principal only. Needs an approved Decision to go to review or close"),
      project_id: z.string().optional().describe("Principal only. Move the task (and its subtasks) to this project"),
    }),
    run: async (env, caller, { task, ...rest }) => {
      const updated = await updateTask(env.DB_CORE, caller, task, rest);
      if (rest.state === "review" && caller.kind === "agent" && caller.id !== "principal") {
        notifyReviewer(env, updated, caller.id);
      }
      if (rest.assignee !== undefined || rest.state === "todo") pokeOrchestrator(env);
      return updated;
    },
  }),
  defineTool({
    name: "tasks_comment",
    description: "Add a comment to a task.",
    input: z.object({ task: taskRef, body: z.string() }),
    run: (env, caller, args) => commentTask(env.DB_CORE, caller, args.task, args.body),
  }),
  defineTool({
    name: "tasks_check_criterion",
    description: "Mark one acceptance criterion as met (checked: true) or not (checked: false). Positions start at 1.",
    input: z.object({ task: taskRef, position: z.number().int().min(1), checked: z.boolean() }),
    run: (env, caller, args) => checkCriterion(env.DB_CORE, caller, args.task, args.position, args.checked),
  }),
  defineTool({
    name: "tasks_close",
    description: "Close a task as done. Only works when every acceptance criterion is checked.",
    input: z.object({ task: taskRef }),
    run: async (env, caller, args) => {
      const task = await closeTask(env.DB_CORE, caller, args.task);
      afterSubtaskFinished(env, task);
      return task;
    },
  }),
  defineTool({
    name: "tasks_send_back",
    description: "Send a task in review back to its agent, saying which criteria failed or what is missing. The agent starts on it again.",
    input: z.object({ task: taskRef, reason: z.string() }),
    run: async (env, caller, args) => {
      const task = await sendBackTask(env.DB_CORE, caller, args.task, args.reason);
      if (task.assignee && task.assignee !== "principal") startAgentOnTask(env, task.assignee, task.identifier);
      return task;
    },
  }),
  defineTool({
    name: "tasks_cancel",
    description: "Cancel a task that won't be done.",
    input: z.object({ task: taskRef }),
    run: async (env, caller, args) => {
      const task = await cancelTask(env.DB_CORE, caller, args.task);
      afterSubtaskFinished(env, task);
      return task;
    },
  }),
  defineTool({
    name: "tasks_create_subtask",
    description:
      "Lead only: split a task assigned to you into a subtask for one of your Operators. Give it its own acceptance criteria. The Operator starts on it automatically.",
    input: z.object({
      parent: taskRef.describe("Your task to split (id or identifier)"),
      description: z.string().describe("What this piece of work is"),
      title: z.string().optional(),
      criteria: z.array(z.string()).describe("Acceptance criteria for this subtask"),
      assignee: z.string().describe("Operator id or name, under you"),
    }),
    run: async (env, caller, args) => {
      const task = await createSubtask(env.DB_CORE, caller, args);
      pokeOrchestrator(env);
      return task;
    },
  }),

  // ---- agents ----
  defineTool({
    name: "agents_list",
    description: "List active agents: the Principal, Leads and the Operators under each Lead.",
    input: z.object({}),
    run: (env) => listAgents(env.DB_CORE),
  }),
  defineTool({
    name: "agents_create",
    description:
      "Create an agent. type lead (reports to the Principal) or operator (needs parent_id of an active Lead). Only create agents when the work needs them.",
    input: z.object({
      name: z.string().describe("Short unique name, e.g. Reports"),
      type: z.enum(["lead", "operator"]),
      parent_id: z.string().optional().describe("Lead id, required for operators"),
      area: z.string().optional().describe("What it owns"),
      model: z.string().optional().describe("Workers AI model id. Defaults per type"),
      code_mode: z.boolean().optional().describe("Code Mode (exec tool). Defaults on for operators, off for leads"),
      sandbox_enabled: z.boolean().optional().describe("Own Linux sandbox (sandbox_run). Default off"),
      sandbox_internet: z.boolean().optional().describe("Sandbox can reach the Internet. Default off"),
      sandbox_persist: z.boolean().optional().describe("Sandbox files survive restarts (snapshots). Default off"),
      container_image: z.string().optional().describe("Sandbox image: debian (default, Node/npm), desktop (Chromium, noVNC) or a custom image"),
      container_instance: z.enum(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"]).optional().describe("Container size. Default per image"),
      skills: z.array(z.string()).optional().describe("Skill names from the library (see skills_list)"),
    }),
    run: async (env, caller, { skills, ...args }) => {
      const agent = await createAgent(env.DB_CORE, caller, args);
      if (skills?.length) await setAgentSkills(env.DB_CORE, caller, agent.id, skills);
      return agent;
    },
  }),
  defineTool({
    name: "skills_list",
    description: "List the skills installed in Flaretown (name, description, whether every agent has it).",
    input: z.object({}),
    run: async (env) =>
      (await listSkills(env.DB_CORE)).map((s) => ({ name: s.name, description: s.description, all_agents: s.all_agents, source: s.source })),
  }),
  defineTool({
    name: "agents_set_skills",
    description:
      "Set the skills an agent has (replaces its list; all-agents skills stay). The Principal can set any agent's skills; a Lead only its own Operators'.",
    input: z.object({ agent: z.string().describe("Agent id"), skills: z.array(z.string()).describe("Skill names, see skills_list") }),
    run: (env, caller, args) => setAgentSkills(env.DB_CORE, caller, args.agent, args.skills),
  }),
  defineTool({
    name: "agents_retire",
    description: "Delete (retire) an agent. Its open tasks go back to its parent. The Principal can never be deleted.",
    input: z.object({ agent: z.string().describe("Agent id or name") }),
    run: async (env, caller, args) => {
      const agent = await retireAgent(env.DB_CORE, caller, args.agent);
      pokeOrchestrator(env);
      rescheduleRoutines(env);
      return agent;
    },
  }),

  // ---- routines ----
  defineTool({
    name: "routines_list",
    description: "List routines (recurring work). owner_id filters by agent.",
    input: z.object({ owner_id: z.string().optional() }),
    run: (env, _caller, args) => listRoutines(env.DB_CORE, args),
  }),
  defineTool({
    name: "routines_create",
    description:
      "Create a routine: a prompt sent to an agent on a schedule. schedule_kind cron (5 fields + timezone, e.g. '0 8 * * *' = every day 08:00), interval (interval_minutes, min 5) or manual. Each run creates a task for the agent.",
    input: z.object({
      name: z.string(),
      owner_id: z.string().optional().describe("Agent id. Defaults to you"),
      schedule_kind: z.enum(["cron", "interval", "manual"]),
      cron: z.string().optional(),
      interval_minutes: z.number().int().optional(),
      timezone: z.string().optional().describe("IANA timezone, default UTC"),
      prompt: z.string().describe("What the agent does on each run"),
      enabled: z.boolean().optional(),
    }),
    run: async (env, caller, args) => {
      const r = await createRoutine(env.DB_CORE, caller, args);
      rescheduleRoutines(env);
      return r;
    },
  }),
  defineTool({
    name: "routines_update",
    description: "Update a routine (schedule, prompt, owner, enabled).",
    input: z.object({
      routine: z.string().describe("Routine id or name"),
      name: z.string().optional(),
      owner_id: z.string().optional(),
      schedule_kind: z.enum(["cron", "interval", "manual"]).optional(),
      cron: z.string().optional(),
      interval_minutes: z.number().int().optional(),
      timezone: z.string().optional(),
      prompt: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
    run: async (env, caller, { routine, ...rest }) => {
      const r = await updateRoutine(env.DB_CORE, caller, routine, rest);
      rescheduleRoutines(env);
      return r;
    },
  }),
  defineTool({
    name: "routines_delete",
    description: "Delete a routine.",
    input: z.object({ routine: z.string() }),
    run: async (env, caller, args) => {
      const r = await deleteRoutine(env.DB_CORE, caller, args.routine);
      rescheduleRoutines(env);
      return r;
    },
  }),
  defineTool({
    name: "routines_run",
    description: "Run a routine now (creates its task and starts its agent).",
    input: z.object({ routine: z.string() }),
    run: async (env, caller, args) => {
      const r = await requireCanRun(env.DB_CORE, caller, args.routine);
      return schedulerStub(env).runNow(r.id);
    },
  }),

  // ---- reports ----
  defineTool({
    name: "reports_save",
    description: "Save a deliverable (markdown report) on a task. Use it for anything the task asks you to produce.",
    input: z.object({ task: taskRef, title: z.string(), markdown: z.string() }),
    run: (env, caller, args) => saveReport(env, caller, args.task, args.title, args.markdown),
  }),
  defineTool({
    name: "reports_list",
    description: "List the reports saved on a task.",
    input: z.object({ task: taskRef }),
    run: (env, _caller, args) => listReports(env.DB_CORE, args.task),
  }),
  defineTool({
    name: "reports_read",
    description: "Read one report saved on a task (by id or title).",
    input: z.object({ task: taskRef, report: z.string() }),
    run: (env, _caller, args) => readReport(env, args.task, args.report),
  }),

  // ---- artifacts repos (SPEC-agents 5.1) ----
  defineTool({
    name: "artifacts_write",
    description:
      "Write a file to your own Artifacts repo (one commit). Use tasks/<identifier>/ for task output and NOTES.md for durable notes. Content null deletes the file.",
    input: z.object({ path: z.string(), content: z.string().nullable(), message: z.string().optional() }),
    run: async (env, caller, args) => {
      if (caller.kind !== "agent") return { error: "Only agents have repos", failed: true };
      const me = await env.DB_CORE.prepare("SELECT name, status FROM agents WHERE id = ?").bind(caller.id).first<{ name: string; status: string }>();
      if (me?.status !== "active") return { error: "Retired agents can't write", failed: true };
      if (args.path.replace(/^\/+/, "").startsWith("pinned/")) return { error: "pinned/ is managed by the human", failed: true };
      const repo = await ensureAgentRepo(env, caller.id);
      const commit = await commitFiles(env, repo, [{ path: args.path, content: args.content }], args.message || `Update ${args.path}`, me.name);
      return { repo, path: args.path, commit };
    },
  }),
  defineTool({
    name: "artifacts_read",
    description: "Read a file from an agent's Artifacts repo (default: yours).",
    input: z.object({ path: z.string(), agent: z.string().optional() }),
    run: async (env, caller, args) => {
      const agentId = args.agent ?? (caller.kind === "agent" ? caller.id : "principal");
      const repo = await ensureAgentRepo(env, agentId);
      const file = await repoFile(env, repo, args.path);
      if (!file) return { error: `No file ${args.path}`, failed: true };
      return { repo, path: args.path, type: file.type, content: file.blob.size > 200_000 ? "(file too large)" : await file.blob.text() };
    },
  }),
  defineTool({
    name: "artifacts_list",
    description: "List files and folders in an agent's Artifacts repo (default: yours) at a path.",
    input: z.object({ path: z.string().optional(), agent: z.string().optional() }),
    run: async (env, caller, args) => {
      const agentId = args.agent ?? (caller.kind === "agent" ? caller.id : "principal");
      const repo = await ensureAgentRepo(env, agentId);
      return { repo, ...(await repoTree(env, repo, args.path ?? "")) };
    },
  }),

  // ---- decisions (task 015) ----
  defineTool({
    name: "decisions_request",
    description:
      "Escalate a call you shouldn't make alone (costly, irreversible, outside your area, or not settled by the task). " +
      "Write the description in three parts:\n## What\nthe proposal: the action to take or the result to accept\n" +
      "## Why\nwhy it's needed and what happens if we don't\n## How\nthe steps, what changes, how to undo it\n" +
      "Add real evidence (report ids, artifact paths, command output, links), not restated claims. " +
      "You'll get the outcome in this chat. Until then, don't do it.",
    input: z.object({
      title: z.string().describe("One line: what needs deciding"),
      description: z.string().describe("Markdown with ## What, ## Why, ## How"),
      evidence: z
        .array(
          z.object({
            kind: z.enum(["text", "link", "report", "artifact", "command"]).optional(),
            label: z.string().optional().describe("Short name, e.g. 'npm audit output'"),
            content: z.string().describe("The evidence itself: text, URL, report id, repo path, or command + output"),
          }),
        )
        .min(1),
      task: z.string().optional().describe("Linked task identifier, e.g. FT-3"),
    }),
    run: async (env, caller, args) => {
      const decision = await createDecision(env.DB_CORE, caller, args);
      evaluateDecisionInBackground(env, decision.id);
      return {
        identifier: decision.identifier,
        status: decision.status,
        note: "Pending. Clef is evaluating it; you'll get the outcome in this chat. Don't act on it until then.",
      };
    },
  }),
  defineTool({
    name: "decisions_add_evidence",
    description: "Add evidence to one of your pending Decisions (Clef re-evaluates it).",
    input: z.object({
      decision: z.string().describe("Decision identifier, e.g. DEC-3"),
      evidence: z
        .array(
          z.object({
            kind: z.enum(["text", "link", "report", "artifact", "command"]).optional(),
            label: z.string().optional(),
            content: z.string(),
          }),
        )
        .min(1),
    }),
    run: async (env, caller, args) => {
      const decision = await addEvidence(env.DB_CORE, caller, args.decision, args.evidence);
      evaluateDecisionInBackground(env, decision.id);
      return { identifier: decision.identifier, evidence: decision.evidence.length, status: decision.status };
    },
  }),
  defineTool({
    name: "decisions_get",
    description: "Get a Decision with its evidence and Clef's evaluation.",
    input: z.object({ decision: z.string().describe("Decision identifier, e.g. DEC-3") }),
    run: (env, _caller, args) => getDecision(env.DB_CORE, args.decision),
  }),
  defineTool({
    name: "decisions_list",
    description: "List Decisions. status: pending (default), approved, rejected, withdrawn, all. mine: only the ones you requested.",
    input: z.object({
      status: z.enum(["pending", "approved", "rejected", "withdrawn", "all"]).optional(),
      mine: z.boolean().optional(),
      task: z.string().optional(),
    }),
    run: async (env, caller, args) => {
      const agent = args.mine && caller.kind === "agent" ? caller.id : undefined;
      const { decisions, counts } = await listDecisions(env.DB_CORE, { status: args.status, agent, task: args.task });
      return {
        counts,
        decisions: decisions.map((d) => ({
          identifier: d.identifier,
          title: d.title,
          status: d.status,
          requested_by: d.requested_by,
          task: d.task_identifier,
          decided_by: d.decided_by,
          recommendation: d.eval_recommendation,
          confidence: d.eval_confidence,
        })),
      };
    },
  }),
  defineTool({
    name: "decisions_withdraw",
    description: "Withdraw one of your pending Decisions (e.g. it's no longer needed).",
    input: z.object({ decision: z.string(), reason: z.string() }),
    run: (env, caller, args) => withdrawDecision(env.DB_CORE, caller, args.decision, args.reason),
  }),

  // ---- time ----
  defineTool({
    name: "time_now",
    description:
      "Current date and time. You don't know the time; always use this tool for anything about 'now'. Optional timezone: an IANA name like America/Argentina/Buenos_Aires or Europe/Dublin.",
    input: z.object({ timezone: z.string().optional() }),
    run: async (env, _caller, args) => {
      const timezone = args.timezone || (await getTimezone(env.DB_CORE));
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
      } catch {
        return { error: `Unknown timezone ${timezone}`, hint: "Use an IANA name, e.g. Europe/Dublin.", failed: true };
      }
      const date = new Date();
      const local = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(date);
      return { iso: date.toISOString(), unix_ms: date.getTime(), timezone, local };
    },
  }),
];

// Which tools each tier gets (SPEC-agents section 3, task authority).
// ---- MCP servers (task 018) and projects (task 019) ----
allTools.push(
  defineTool({
    name: "projects_list",
    description: "List projects with their open, in-review and recent done task counts, owner Lead and status. Use the id as project_id for tasks.",
    input: z.object({ status: z.enum(["active", "archived", "all"]).optional().describe("Default active") }),
    run: (env, _caller, args) => listProjects(env.DB_CORE, { status: args.status ?? "active" }),
  }),
  defineTool({
    name: "projects_create",
    description:
      "Create a project when a new stream of work starts (a product, client or initiative), then put its tasks in it. Principal only. owner_id: optional Lead that owns it.",
    input: z.object({
      name: z.string(),
      description: z.string().optional().describe("What the project is about, one paragraph"),
      owner_id: z.string().optional().describe("Lead id"),
    }),
    run: (env, caller, args) => createProject(env.DB_CORE, caller, args),
  }),
  defineTool({
    name: "projects_update",
    description: "Rename a project, change its description or owner Lead, or archive / unarchive it. Principal only. Default can't be archived.",
    input: z.object({
      project: z.string().describe("Project id"),
      name: z.string().optional(),
      description: z.string().optional(),
      owner_id: z.string().nullable().optional().describe("Lead id, or null for none"),
      status: z.enum(["active", "archived"]).optional(),
    }),
    run: async (env, caller, { project, status, ...rest }) => {
      if (Object.values(rest).some((v) => v !== undefined)) await updateProject(env.DB_CORE, caller, project, rest);
      if (status) return setProjectStatus(env.DB_CORE, caller, project, status);
      return getProject(env.DB_CORE, project);
    },
  }),
  defineTool({
    name: "mcps_list",
    description:
      "List the MCP servers set up in Flaretown (id, name, auth, policy) and which agents have them. agent filters to one agent. Never shows secrets.",
    input: z.object({ agent: z.string().optional().describe("Agent id") }),
    run: (env, _caller, args) => listForAgents(env.DB_CORE, args.agent),
  }),
  defineTool({
    name: "mcps_attach",
    description:
      "Give an agent an MCP server: its tools show up in that agent's next turn. Only servers with policy allowed and no OAuth. The Principal can attach to any agent; a Lead only to its own Operators.",
    input: z.object({ agent: z.string().describe("Agent id"), server: z.string().describe("MCP server id, see mcps_list") }),
    run: (env, caller, args) => attachServer(env, caller, args.agent, args.server),
  }),
  defineTool({
    name: "mcps_detach",
    description: "Remove an MCP server from an agent. The Principal can do it for any agent; a Lead only for its own Operators.",
    input: z.object({ agent: z.string().describe("Agent id"), server: z.string().describe("MCP server id") }),
    run: (env, caller, args) => detachServer(env, caller, args.agent, args.server),
  }),
);

const TIER_TOOLS: Record<string, string[]> = {
  principal: allTools.map((t) => t.name),
  lead: [
    "tasks_list", "tasks_get", "tasks_update", "tasks_comment", "tasks_create_subtask",
    "tasks_check_criterion", "tasks_close", "tasks_send_back", "tasks_cancel",
    "agents_list", "agents_create", "agents_retire", "agents_set_skills", "skills_list",
    "mcps_list", "mcps_attach", "mcps_detach", "projects_list",
    "routines_list", "routines_create", "routines_update", "routines_delete", "routines_run",
    "reports_save", "reports_list", "reports_read", "artifacts_write", "artifacts_read", "artifacts_list", "time_now",
    "decisions_request", "decisions_add_evidence", "decisions_get", "decisions_list", "decisions_withdraw",
  ],
  operator: [
    "tasks_get", "tasks_update", "tasks_comment", "mcps_list", "projects_list",
    "routines_list", "routines_create", "routines_update", "routines_delete", "routines_run",
    "reports_save", "reports_list", "reports_read", "artifacts_write", "artifacts_read", "artifacts_list", "time_now",
    "decisions_request", "decisions_add_evidence", "decisions_get", "decisions_list", "decisions_withdraw",
  ],
};

export function toolsForTier(tier: string): ToolDef[] {
  const names = TIER_TOOLS[tier] ?? [];
  return allTools.filter((t) => names.includes(t.name));
}
