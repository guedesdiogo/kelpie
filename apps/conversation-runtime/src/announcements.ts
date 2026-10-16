import type { Locale, Localized } from "@kelpie/channels";
import { visible } from "./tools.ts";

// What Kelpie tells the conversation its agent's tools did (ADR-0036 §4 and §6): a task handed to
// another agent, and who has it now (#287); a subagent created or deleted (#342); an agent Master
// created or renamed (#387). Each names the agent by name and id. These are Kelpie's fixed texts
// (ADR-0027), never the model's, so the model can't alter or omit them.

/** Something a turn's tools did that Kelpie announces after the next reply. */
export type Announcement =
  | {
      kind: "handoff";
      taskId: string;
      /** The agent that has the task, by its id and its Registry name. */
      agentId: string;
      name: string;
    }
  /**
   * A subagent created or deleted (#342), or an agent Master's tools created or renamed (#387),
   * with its name after the change.
   */
  | {
      kind: "created" | "deleted" | "agentCreated" | "agentRenamed";
      agentId: string;
      name: string;
    };

/** An announcement as a conversation kept it: one from before #342 is a handoff with no kind. */
export type StoredAnnouncement =
  | Announcement
  | { kind?: undefined; taskId: string; agentId: string; name: string };

/** The announcements a conversation kept, each with its kind. */
export function stored(kept: readonly StoredAnnouncement[]): Announcement[] {
  return kept.map((one) => (one.kind === undefined ? { ...one, kind: "handoff" } : one));
}

/**
 * What tells two announcements apart: a handoff's task, or what happened to which agent. A rename
 * also by its new name, so a notice that named one rename doesn't count as naming a later one.
 */
export function keyOf(announcement: Announcement): string {
  if (announcement.kind === "handoff") return announcement.taskId;
  const key = `${announcement.kind}:${announcement.agentId}`;
  return announcement.kind === "agentRenamed" ? `${key}:${announcement.name}` : key;
}

/** Whether `later` makes `earlier` stale: the same news again, or a newer name for that agent. */
export function replaces(later: Announcement, earlier: Announcement): boolean {
  return (
    keyOf(later) === keyOf(earlier) ||
    (later.kind === "agentRenamed" &&
      earlier.kind === "agentRenamed" &&
      later.agentId === earlier.agentId)
  );
}

type Line = { one: (to: string) => string; several: (to: string) => string };

const TEXTS: Localized<{
  agentCreated: Line;
  created: Line;
  agentRenamed: Line;
  /** A renamed agent, by its id and its new name, already quoted. */
  renamedTo: (id: string, name: string) => string;
  handoff: Line;
  deleted: Line;
  and: string;
  /** The agents a line counts past the ones it names. */
  more: (count: number) => string;
}> = {
  en: {
    agentCreated: {
      one: (to) => `Kelpie created the agent ${to}.`,
      several: (to) => `Kelpie created the agents ${to}.`,
    },
    created: {
      one: (to) => `Kelpie created the subagent ${to}.`,
      several: (to) => `Kelpie created the subagents ${to}.`,
    },
    agentRenamed: {
      one: (to) => `Kelpie renamed the agent ${to}.`,
      several: (to) => `Kelpie renamed the agents ${to}.`,
    },
    renamedTo: (id, name) => `${id} to ${name}`,
    handoff: {
      one: (to) => `Kelpie handed a task to ${to}.`,
      several: (to) => `Kelpie handed tasks to ${to}.`,
    },
    deleted: {
      one: (to) => `Kelpie deleted the subagent ${to}.`,
      several: (to) => `Kelpie deleted the subagents ${to}.`,
    },
    and: "and",
    more: (count) => `${count} more`,
  },
  "pt-BR": {
    agentCreated: {
      one: (to) => `O Kelpie criou o agente ${to}.`,
      several: (to) => `O Kelpie criou os agentes ${to}.`,
    },
    created: {
      one: (to) => `O Kelpie criou o subagente ${to}.`,
      several: (to) => `O Kelpie criou os subagentes ${to}.`,
    },
    agentRenamed: {
      one: (to) => `O Kelpie renomeou o agente ${to}.`,
      several: (to) => `O Kelpie renomeou os agentes ${to}.`,
    },
    renamedTo: (id, name) => `${id} para ${name}`,
    handoff: {
      one: (to) => `O Kelpie passou uma tarefa para ${to}.`,
      several: (to) => `O Kelpie passou tarefas para ${to}.`,
    },
    deleted: {
      one: (to) => `O Kelpie excluiu o subagente ${to}.`,
      several: (to) => `O Kelpie excluiu os subagentes ${to}.`,
    },
    and: "e",
    more: (count) => `mais ${count}`,
  },
  es: {
    agentCreated: {
      one: (to) => `Kelpie creó el agente ${to}.`,
      several: (to) => `Kelpie creó los agentes ${to}.`,
    },
    created: {
      one: (to) => `Kelpie creó el subagente ${to}.`,
      several: (to) => `Kelpie creó los subagentes ${to}.`,
    },
    agentRenamed: {
      one: (to) => `Kelpie renombró el agente ${to}.`,
      several: (to) => `Kelpie renombró los agentes ${to}.`,
    },
    renamedTo: (id, name) => `${id} como ${name}`,
    handoff: {
      one: (to) => `Kelpie pasó una tarea a ${to}.`,
      several: (to) => `Kelpie pasó tareas a ${to}.`,
    },
    deleted: {
      one: (to) => `Kelpie eliminó el subagente ${to}.`,
      several: (to) => `Kelpie eliminó los subagentes ${to}.`,
    },
    and: "y",
    more: (count) => `${count} más`,
  },
};

/** The kinds in the order a notice tells them: what was made, renamed, handed off, then deleted. */
const ORDER = ["agentCreated", "created", "agentRenamed", "handoff", "deleted"] as const;

/**
 * The most agents a line names, and the most of a name it shows once written out: past them it
 * counts the agents and cuts the name, so a notice fits one Telegram message (#387).
 */
const MAX_NAMED = 4;
const MAX_SHOWN_NAME = 80;

/**
 * A name in quotes: a subagent's, or one Master's tools set, is the model's choice, and only the id
 * is Kelpie's. Each backslash and quote is escaped, so it can't close them, and `visible` writes out
 * what wouldn't show. A name past MAX_SHOWN_NAME ends in "…", never in half an escape.
 */
function quoted(name: string): string {
  let shown = "";
  for (const character of name) {
    const written = visible(character.replace(/[\\"]/, "\\$&"));
    if (shown.length + written.length > MAX_SHOWN_NAME) return `"${shown}…"`;
    shown += written;
  }
  return `"${shown}"`;
}

/**
 * The notice for these announcements, a line for each kind, naming each agent once, the first
 * MAX_NAMED of them by name; null without one.
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
      if (!agents.has(agentId)) {
        agents.set(
          agentId,
          kind === "agentRenamed"
            ? texts.renamedTo(agentId, quoted(name))
            : name === agentId
              ? agentId
              : `${quoted(name)} (${agentId})`,
        );
      }
    }
    const all = [...agents.values()];
    const named =
      all.length > MAX_NAMED
        ? [...all.slice(0, MAX_NAMED), texts.more(all.length - MAX_NAMED)]
        : all;
    const last = named.pop() ?? "";
    const to = named.length === 0 ? last : `${named.join(", ")} ${texts.and} ${last}`;
    return [these.length === 1 ? texts[kind].one(to) : texts[kind].several(to)];
  });
  return lines.length === 0 ? null : lines.join("\n");
}
