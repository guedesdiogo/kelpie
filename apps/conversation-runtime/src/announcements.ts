import type { Locale, Localized } from "@kelpie/channels";
import { visible } from "./tools.ts";

// What Kelpie tells the conversation its agent's tools did (ADR-0036 §4 and §6): a task handed to
// another agent, and who has it now (#287); a subagent created or deleted (#342). Each names the
// agent by name and id. These are Kelpie's fixed texts (ADR-0027), never the model's, so the model
// can't alter or omit them.

/** Something a turn's tools did that Kelpie announces after the next reply. */
export type Announcement =
  | {
      kind: "handoff";
      taskId: string;
      /** The agent that has the task, by its id and its Registry name. */
      agentId: string;
      name: string;
    }
  | { kind: "created" | "deleted"; agentId: string; name: string };

/** An announcement as a conversation kept it: one from before #342 is a handoff with no kind. */
export type StoredAnnouncement =
  | Announcement
  | { kind?: undefined; taskId: string; agentId: string; name: string };

/** The announcements a conversation kept, each with its kind. */
export function stored(kept: readonly StoredAnnouncement[]): Announcement[] {
  return kept.map((one) => (one.kind === undefined ? { ...one, kind: "handoff" } : one));
}

/** What tells two announcements apart: a handoff's task, or what happened to which subagent. */
export function keyOf(announcement: Announcement): string {
  return announcement.kind === "handoff"
    ? announcement.taskId
    : `${announcement.kind}:${announcement.agentId}`;
}

type Line = { one: (to: string) => string; several: (to: string) => string };

const TEXTS: Localized<{ created: Line; handoff: Line; deleted: Line; and: string }> = {
  en: {
    created: {
      one: (to) => `Kelpie created the subagent ${to}.`,
      several: (to) => `Kelpie created the subagents ${to}.`,
    },
    handoff: {
      one: (to) => `Kelpie handed a task to ${to}.`,
      several: (to) => `Kelpie handed tasks to ${to}.`,
    },
    deleted: {
      one: (to) => `Kelpie deleted the subagent ${to}.`,
      several: (to) => `Kelpie deleted the subagents ${to}.`,
    },
    and: "and",
  },
  "pt-BR": {
    created: {
      one: (to) => `O Kelpie criou o subagente ${to}.`,
      several: (to) => `O Kelpie criou os subagentes ${to}.`,
    },
    handoff: {
      one: (to) => `O Kelpie passou uma tarefa para ${to}.`,
      several: (to) => `O Kelpie passou tarefas para ${to}.`,
    },
    deleted: {
      one: (to) => `O Kelpie excluiu o subagente ${to}.`,
      several: (to) => `O Kelpie excluiu os subagentes ${to}.`,
    },
    and: "e",
  },
  es: {
    created: {
      one: (to) => `Kelpie creó el subagente ${to}.`,
      several: (to) => `Kelpie creó los subagentes ${to}.`,
    },
    handoff: {
      one: (to) => `Kelpie pasó una tarea a ${to}.`,
      several: (to) => `Kelpie pasó tareas a ${to}.`,
    },
    deleted: {
      one: (to) => `Kelpie eliminó el subagente ${to}.`,
      several: (to) => `Kelpie eliminó los subagentes ${to}.`,
    },
    and: "y",
  },
};

/** The kinds in the order a notice tells them: what was made, handed off, then deleted. */
const ORDER = ["created", "handoff", "deleted"] as const;

/**
 * The notice for these announcements, a line for each kind, naming each agent once; null without
 * one.
 */
export function announcementNotice(
  announcements: readonly Announcement[],
  locale: Locale,
): string | null {
  const texts = TEXTS[locale];
  const lines = ORDER.flatMap((kind) => {
    const these = announcements.filter((one) => one.kind === kind);
    if (these.length === 0) return [];
    const agents = new Map<string, string>();
    for (const { agentId, name } of these) {
      // The name in quotes: a subagent's is the model's choice, and only the id is Kelpie's.
      if (!agents.has(agentId)) {
        agents.set(
          agentId,
          name === agentId ? agentId : `"${visible(name).replaceAll('"', '\\"')}" (${agentId})`,
        );
      }
    }
    const named = [...agents.values()];
    const last = named.pop() ?? "";
    const to = named.length === 0 ? last : `${named.join(", ")} ${texts.and} ${last}`;
    return [these.length === 1 ? texts[kind].one(to) : texts[kind].several(to)];
  });
  return lines.length === 0 ? null : lines.join("\n");
}
