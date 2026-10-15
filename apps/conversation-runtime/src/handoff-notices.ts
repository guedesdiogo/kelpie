import type { Locale, Localized } from "@kelpie/channels";
import { visible } from "./tools.ts";

// What Kelpie tells the conversation when its agent hands work to another (ADR-0036 §4 and §6,
// #287): who has it now, by name and id. This is Kelpie's fixed text (ADR-0027), never the model's,
// so the model can't alter or omit it.

/** A task a turn's tools handed to another agent. */
export interface Handoff {
  taskId: string;
  /** The agent that has it, by its id and its Registry name. */
  agentId: string;
  name: string;
}

const TEXTS: Localized<{
  one: (to: string) => string;
  several: (to: string) => string;
  and: string;
}> = {
  en: {
    one: (to) => `Kelpie handed a task to ${to}.`,
    several: (to) => `Kelpie handed tasks to ${to}.`,
    and: "and",
  },
  "pt-BR": {
    one: (to) => `O Kelpie passou uma tarefa para ${to}.`,
    several: (to) => `O Kelpie passou tarefas para ${to}.`,
    and: "e",
  },
  es: {
    one: (to) => `Kelpie pasó una tarea a ${to}.`,
    several: (to) => `Kelpie pasó tareas a ${to}.`,
    and: "y",
  },
};

/** The notice for these handoffs, naming each agent once; null without one. */
export function handoffNotice(handoffs: readonly Handoff[], locale: Locale): string | null {
  if (handoffs.length === 0) return null;
  const texts = TEXTS[locale];
  const agents = new Map<string, string>();
  for (const { agentId, name } of handoffs) {
    if (!agents.has(agentId)) {
      agents.set(agentId, name === agentId ? agentId : `${visible(name)} (${agentId})`);
    }
  }
  const named = [...agents.values()];
  const last = named.pop() ?? "";
  const to = named.length === 0 ? last : `${named.join(", ")} ${texts.and} ${last}`;
  return handoffs.length === 1 ? texts.one(to) : texts.several(to);
}
