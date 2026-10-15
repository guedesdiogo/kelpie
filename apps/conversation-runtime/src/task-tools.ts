import {
  isAgentId,
  isTaskId,
  MAX_TASK_TITLE,
  type NewTask,
  type TaskResult,
  type TaskView,
} from "@kelpie/config";
import type { Tool, ToolContext, ToolOutcome, ToolProvider } from "./tools.ts";

// The agents' task tools (ADR-0011, ADR-0036 §4, #335). In a task's own conversation, the run ends
// its task: done with a result, waiting with a question, or cancelled. Any agent that owns another
// hands it work as a task, and answers on the tasks it hears about.

/** What the task tools reach: the Registry's owners, and other agents' boards. */
export interface TaskToolPorts {
  /** The agents `agentId` owns (ADR-0036 §1). */
  owned(agentId: string): Promise<string[]>;
  create(
    assignee: string,
    task: NewTask,
    creator: { agentId: string; actingUserId: string },
  ): Promise<TaskResult<TaskView>>;
  comment(
    assignee: string,
    taskId: string,
    text: string,
    by: string,
  ): Promise<TaskResult<TaskView>>;
}

const MAX_WORDS = 8_000;
/** The most tasks one turn hands off: a burst of them is a loop, not a plan. */
const MAX_CREATES_PER_TURN = 3;

const SPECS = {
  complete_task: {
    name: "complete_task",
    description:
      "End your task as done, with its result: what you did and what came of it, for whoever gave you the task.",
    inputSchema: {
      type: "object",
      properties: { result: { type: "string", description: "The result, in full." } },
      required: ["result"],
      additionalProperties: false,
    },
  },
  wait_on_task: {
    name: "wait_on_task",
    description:
      "Put your task on hold. With needs_input, your question goes to the owner through the agent that gave you the task, and their answer resumes it. With dependency, it waits on other work, and no one is asked.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["needs_input", "dependency"] },
        question: { type: "string", description: "What you need, in one message." },
      },
      required: ["reason", "question"],
      additionalProperties: false,
    },
  },
  cancel_task: {
    name: "cancel_task",
    description: "End your task without doing it, with the reason.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  comment_task: {
    name: "comment_task",
    description:
      "Comment on a task. Without agentId and taskId, on the task you are running, as a note on your progress. With them, on a task of an agent you own or one Kelpie told you about: an answer to its question resumes it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        agentId: { type: "string", description: "The agent whose task it is." },
        taskId: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  create_task: {
    name: "create_task",
    description:
      "Hand work to an agent you own, as a task on its board. It runs on its own; Kelpie tells you when it ends or asks something.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent you own that does it." },
        title: { type: "string", description: "One line." },
        body: { type: "string", description: "What to do, with all it needs to know." },
      },
      required: ["agentId", "title", "body"],
      additionalProperties: false,
    },
  },
} as const satisfies Record<string, Tool["spec"]>;

const failed = (output: string): ToolOutcome => ({ output, isError: true });
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
const words = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_WORDS
    ? value.trim()
    : null;

const GONE = failed(
  "The run no longer holds the task: it was stopped, or its time ran out. Stop working on it.",
);
const NO_TASK = failed("This conversation isn't running a task: name the agentId and taskId.");

/** Ends the run as `outcome` says, or says why it couldn't. */
async function finish(
  context: ToolContext,
  outcome: Parameters<NonNullable<ToolContext["task"]>["finish"]>[0],
  done: string,
) {
  if (!context.task) return NO_TASK;
  return (await context.task.finish(outcome)) ? { output: done } : GONE;
}

export function taskTools(ports: TaskToolPorts): ToolProvider {
  const inTask: Tool[] = [
    {
      spec: SPECS.complete_task,
      label: {
        en: "Finishing a task",
        "pt-BR": "Concluindo uma tarefa",
        es: "Terminando una tarea",
      },
      async run(input, context) {
        const result = words(fields(input).result);
        if (result === null) return failed("Give the result: one to 8,000 characters.");
        return finish(context, { status: "done", result }, "The task is done, with its result.");
      },
    },
    {
      spec: SPECS.wait_on_task,
      label: {
        en: "Asking about a task",
        "pt-BR": "Perguntando sobre uma tarefa",
        es: "Preguntando sobre una tarea",
      },
      async run(input, context) {
        const { reason } = fields(input);
        const question = words(fields(input).question);
        if ((reason !== "needs_input" && reason !== "dependency") || question === null) {
          return failed("Give the reason, needs_input or dependency, and your question.");
        }
        if (!context.task) return NO_TASK;
        if (!(await context.task.comment(question))) return GONE;
        return finish(
          context,
          { status: "waiting", reason },
          reason === "needs_input"
            ? "The task waits for an answer: your question goes to the owner. Stop here."
            : "The task waits on the other work. Stop here.",
        );
      },
    },
    {
      spec: SPECS.cancel_task,
      label: {
        en: "Cancelling a task",
        "pt-BR": "Cancelando uma tarefa",
        es: "Cancelando una tarea",
      },
      async run(input, context) {
        const reason = words(fields(input).reason);
        if (reason === null) return failed("Give the reason.");
        return finish(context, { status: "cancelled", result: reason }, "The task is cancelled.");
      },
    },
  ];
  const comment: Tool = {
    spec: SPECS.comment_task,
    label: {
      en: "Commenting on a task",
      "pt-BR": "Comentando uma tarefa",
      es: "Comentando una tarea",
    },
    async run(input, context) {
      const { agentId, taskId } = fields(input);
      const text = words(fields(input).text);
      if (text === null) return failed("Give the comment: one to 8,000 characters.");
      if (agentId === undefined && taskId === undefined) {
        if (!context.task) return NO_TASK;
        return (await context.task.comment(text)) ? { output: "Commented on your task." } : GONE;
      }
      // A run comments only on its own task.
      if (context.task)
        return failed(
          "In a task's run, comment only on your own task: leave out agentId and taskId.",
        );
      if (!isAgentId(agentId) || !isTaskId(taskId)) {
        return failed("Name the task by the agentId and taskId Kelpie gave you.");
      }
      const result = await ports.comment(agentId, taskId, text, context.agentId);
      if (result.ok) {
        return {
          output:
            result.value.status === "todo"
              ? `Commented on the task ${taskId}; it goes back to the agent ${agentId} to do.`
              : `Commented on the task ${taskId}.`,
        };
      }
      return failed(
        result.reason === "not_allowed"
          ? "You can comment only on your own tasks, the tasks you created, and those of agents you own."
          : `The agent ${agentId} has no task ${taskId}.`,
      );
    },
  };
  const created = new Map<string, number>();
  const create: Tool = {
    spec: SPECS.create_task,
    label: { en: "Handing off a task", "pt-BR": "Passando uma tarefa", es: "Pasando una tarea" },
    async run(input, context) {
      const { agentId, title, body } = fields(input);
      if (context.actor.role !== "owner") return failed("Only the owner's turns hand off tasks.");
      if (!isAgentId(agentId) || typeof title !== "string" || typeof body !== "string") {
        return failed("Give the agentId, a one-line title and the body.");
      }
      // A turn's calls share it; a turn's id alone repeats across conversations.
      const turnKey = `${context.agentId}\n${context.source}\n${context.turn}`;
      const count = created.get(turnKey) ?? 0;
      if (count >= MAX_CREATES_PER_TURN) {
        return failed(`One turn hands off at most ${MAX_CREATES_PER_TURN} tasks.`);
      }
      if (!(await ports.owned(context.agentId)).includes(agentId)) {
        return failed(`You don't own an agent ${agentId}: hand tasks only to agents you own.`);
      }
      const task = { title: title.trim(), body, status: "todo" as const, scheduledStartAt: null };
      if (task.title === "" || task.title.length > MAX_TASK_TITLE) {
        return failed("The title is one line of up to 200 characters.");
      }
      const made = await ports.create(agentId, task, {
        agentId: context.agentId,
        actingUserId: context.actor.userId,
      });
      if (!made.ok) {
        return failed(
          made.reason === "not_allowed"
            ? `The agent ${agentId} can't take it: you don't own it, or its board is full.`
            : "That task isn't valid: a title of one line, and a body of up to 20,000 characters.",
        );
      }
      // Kept for the last few turns only.
      created.set(turnKey, count + 1);
      if (created.size > 50) created.delete(created.keys().next().value ?? "");
      return {
        output: `Created the task ${made.value.id} for the agent ${agentId}. Kelpie tells you when it ends or asks something.`,
      };
    },
  };
  return {
    async tools(agentId, place) {
      const owned = await ports.owned(agentId).catch(() => []);
      return [
        ...(place?.channel === "task" ? inTask : []),
        comment,
        ...(owned.length > 0 ? [create] : []),
      ];
    },
  };
}
