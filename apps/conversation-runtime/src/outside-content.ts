import type { Locale, Localized } from "@kelpie/channels";
import { RUN_ENDS } from "./task-tools.ts";
import {
  CONFIRMATION_MS,
  type ConfirmationRequest,
  canonicalJson,
  labelIn,
  MAX_SUMMARY_CHARS,
  type Tool,
  type ToolOutcome,
  visible,
} from "./tools.ts";

// A turn that read outside content asks the owner before it changes anything (ADR-0063, #454).
// Outside content is text that neither Kelpie, its code or its agents, nor the owner wrote, such as
// a VPS session's title: a tool marks the result that holds it, and the turn keeps the mark. From
// then on, each call of a tool that changes something with no yes of its own waits for the
// owner's, through ADR-0013's confirmation. A task's run has no one to answer one yet, so there the
// call doesn't run, Kelpie asks the owner on the task, and the task waits (#477 brings the yes).

/**
 * How long a turn that read outside content marks the turns that follow it, the owner's own
 * included (the owner's decision of 2026-10-21: «10 minutos»): as long as a code lasts.
 */
export const OUTSIDE_WINDOW_MS = CONFIRMATION_MS;

/** The most changes one turn holds for the owner at once: past them, the call asks nothing. */
export const MAX_HELD = 3;

/** What a held call gets until the owner confirms it, as the configuration tools' own wait. */
export const OUTSIDE_WAITING =
  "Not done yet: this turn read text that neither Kelpie nor the owner wrote, so Kelpie showed the owner this change, and how to confirm it. Tell them it waits for their confirmation. Once they confirm, call this tool again with the same input.";

/** What a held call too long to show the owner gets: one bubble shows the whole change, or none. */
export const OUTSIDE_TOO_LONG =
  "Not done: this turn read text that neither Kelpie nor the owner wrote, so this change waits for the owner's confirmation, and it is too long to show them. Make it smaller, or tell the owner what you would change: a message of their own can ask for it.";

/** What a held call gets once its turn holds MAX_HELD changes for the owner: no code is made. */
export const OUTSIDE_TOO_MANY = `Not done: this turn read text that neither Kelpie nor the owner wrote, and ${MAX_HELD} changes already wait for the owner's confirmation in it. Don't ask for more: tell the owner what else you would change, so they can ask for it in a message.`;

/**
 * What a session page and a checkpoint's summary keep of a reply whose turn read outside content,
 * which it may quote (the owner's decision of 2026-10-21: «Tirar dos registros»).
 */
export const OUTSIDE_REPLY_LEFT_OUT =
  "(A reply left out of this record: its turn read text that neither Kelpie nor the owner wrote.)";

/** What a held call in a task's run gets, once Kelpie asked the owner on the task. */
export const OUTSIDE_HELD =
  "Not done: this run read text that neither Kelpie nor the owner wrote, so this change waits for the owner's confirmation, which a task's run can't take yet. Kelpie asked the owner on the task, which now waits for their answer. Stop here.";

/** What a held call in a task's run gets when the run no longer holds its task. */
export const OUTSIDE_RUN_GONE =
  "Not done: this run read text that neither Kelpie nor the owner wrote, so this change waits for the owner's confirmation, and the run no longer holds the task. Stop working on it.";

const TEXTS: Localized<{
  /** The confirmation's summary: it starts in lower case, after the notice's "Confirm:". */
  summary: (call: string, input: string) => string;
  /** Kelpie's question on the task, for the owner. */
  question: (call: string, input: string) => string;
}> = {
  en: {
    summary: (call, input) =>
      `run ${call} with ${input}. This turn read text that neither you nor Kelpie wrote, so Kelpie asks you before any change.`,
    question: (call, input) =>
      `Kelpie held a change until the owner confirms it: ${call} with ${input}. This run read text that neither Kelpie nor the owner wrote, and a task's run can't take the owner's confirmation yet, so the change didn't run. The owner can ask for it in a message of their own.`,
  },
  "pt-BR": {
    summary: (call, input) =>
      `executar ${call} com ${input}. Este turno leu um texto que nem você nem o Kelpie escreveram, então o Kelpie pergunta a você antes de qualquer mudança.`,
    question: (call, input) =>
      `O Kelpie segurou uma mudança até o dono confirmá-la: ${call} com ${input}. Esta execução leu um texto que nem o Kelpie nem o dono escreveram, e a execução de uma tarefa ainda não aceita a confirmação do dono, então a mudança não foi feita. O dono pode pedi-la numa mensagem própria.`,
  },
  es: {
    summary: (call, input) =>
      `ejecutar ${call} con ${input}. Este turno leyó un texto que ni tú ni Kelpie escribieron, así que Kelpie te pregunta antes de cualquier cambio.`,
    question: (call, input) =>
      `Kelpie retuvo un cambio hasta que el dueño lo confirme: ${call} con ${input}. Esta ejecución leyó un texto que ni Kelpie ni el dueño escribieron, y la ejecución de una tarea aún no acepta la confirmación del dueño, así que el cambio no se hizo. El dueño puede pedirlo en un mensaje propio.`,
  },
};

/**
 * Whether a call of `tool` waits for the owner's yes after outside content: it declares no effect,
 * so it changes something with no yes of its own, and it isn't a run's own end of its task.
 */
export function changes(tool: Tool): boolean {
  return tool.effect === undefined && !RUN_ENDS.has(tool.spec.name);
}

/** The call as Kelpie names it: the tool's name, its label in `locale`, and its input, all visible. */
function named(tool: Tool, input: unknown, locale: Locale): [string, string] {
  return [
    `${tool.spec.name} (${JSON.stringify(labelIn(tool.label, locale))})`,
    visible(canonicalJson(input)),
  ];
}

/** What the owner is asked to confirm, in `locale` (ADR-0027): Kelpie's words around the call. */
export function heldSummary(tool: Tool, input: unknown, locale: Locale): string {
  return TEXTS[locale].summary(...named(tool, input, locale));
}

/** Kelpie's question on a task whose run it held a change of, in `locale`. */
export function heldQuestion(tool: Tool, input: unknown, locale: Locale): string {
  return TEXTS[locale].question(...named(tool, input, locale));
}

/**
 * `tool`, held until the owner's yes: the call runs only once they confirmed exactly it, with
 * exactly this input, and a yes runs it once (ADR-0013). `room` says whether the turn may ask the
 * owner this: a change already shown asks again, and a turn shows at most MAX_HELD. In a task's run
 * the call never runs, until #477: Kelpie asks the owner on the task, and the run ends waiting for
 * their answer, as `wait_on_task` with `needs_input` does.
 */
export function held(tool: Tool, room: (request: ConfirmationRequest) => boolean): Tool {
  return {
    ...tool,
    async run(input, context): Promise<ToolOutcome> {
      const summary = heldSummary(tool, input, context.locale);
      if (visible(summary).length > MAX_SUMMARY_CHARS) {
        return { output: OUTSIDE_TOO_LONG, isError: true };
      }
      if (context.trigger === "task") {
        const run = context.task;
        const asked =
          run !== undefined &&
          (await run.comment(heldQuestion(tool, input, context.locale))) &&
          (await run.finish({ status: "waiting", reason: "needs_input" }));
        return asked ? { output: OUTSIDE_HELD } : { output: OUTSIDE_RUN_GONE, isError: true };
      }
      const request = { command: `tool:${tool.spec.name}`, input, summary };
      if (!room(request)) return { output: OUTSIDE_TOO_MANY, isError: true };
      const confirmed = await context.confirm(request);
      return confirmed ? tool.run(input, context) : { output: OUTSIDE_WAITING };
    },
  };
}
