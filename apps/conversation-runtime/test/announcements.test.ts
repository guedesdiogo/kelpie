import { describe, expect, it } from "vitest";
import {
  type Announcement,
  announcementNotice,
  keyOf,
  replaces,
  stored,
} from "../src/announcements.ts";
import { MAX_SUMMARY_CHARS } from "../src/tools.ts";

// Kelpie's notices of what a turn's tools did (ADR-0036 §4 and §6): a handoff names who has the
// work (#287), and a subagent created or deleted is named too (#342), as is an agent Master
// created or renamed (#387), by name and id, in the conversation's language.

const sales: Announcement = { kind: "handoff", taskId: "t1", agentId: "sales", name: "Sales" };
const travel: Announcement = { kind: "handoff", taskId: "t2", agentId: "travel", name: "Viagens" };
const scout = { agentId: "kelpie-sub-a1b2c3", name: "Scout" };

describe("announcementNotice", () => {
  it("names the agent a task went to by its name and id, in the conversation's language", () => {
    expect(announcementNotice([sales], "en")).toBe('Kelpie handed a task to "Sales" (sales).');
    expect(announcementNotice([sales], "pt-BR")).toBe(
      'O Kelpie passou uma tarefa para "Sales" (sales).',
    );
    expect(announcementNotice([sales], "es")).toBe('Kelpie pasó una tarea a "Sales" (sales).');
  });

  it("names each agent once, however many tasks it got", () => {
    const again: Announcement = { ...sales, taskId: "t3" };
    expect(announcementNotice([sales, travel, again], "en")).toBe(
      'Kelpie handed tasks to "Sales" (sales) and "Viagens" (travel).',
    );
    expect(announcementNotice([sales, again], "pt-BR")).toBe(
      'O Kelpie passou tarefas para "Sales" (sales).',
    );
    const third: Announcement = { kind: "handoff", taskId: "t4", agentId: "docs", name: "Docs" };
    expect(announcementNotice([sales, travel, third], "es")).toBe(
      'Kelpie pasó tareas a "Sales" (sales), "Viagens" (travel) y "Docs" (docs).',
    );
  });

  it("names a subagent created or deleted, in the conversation's language (#342)", () => {
    const created: Announcement = { kind: "created", ...scout };
    const deleted: Announcement = { kind: "deleted", ...scout };
    expect(announcementNotice([created], "en")).toBe(
      'Kelpie created the subagent "Scout" (kelpie-sub-a1b2c3).',
    );
    expect(announcementNotice([deleted], "en")).toBe(
      'Kelpie deleted the subagent "Scout" (kelpie-sub-a1b2c3).',
    );
    expect(announcementNotice([created], "pt-BR")).toBe(
      'O Kelpie criou o subagente "Scout" (kelpie-sub-a1b2c3).',
    );
    expect(announcementNotice([deleted], "pt-BR")).toBe(
      'O Kelpie excluiu o subagente "Scout" (kelpie-sub-a1b2c3).',
    );
    expect(announcementNotice([created], "es")).toBe(
      'Kelpie creó el subagente "Scout" (kelpie-sub-a1b2c3).',
    );
    expect(announcementNotice([deleted], "es")).toBe(
      'Kelpie eliminó el subagente "Scout" (kelpie-sub-a1b2c3).',
    );
    const other: Announcement = { kind: "created", agentId: "kelpie-sub-d4e5f6", name: "Clerk" };
    expect(announcementNotice([created, other], "pt-BR")).toBe(
      'O Kelpie criou os subagentes "Scout" (kelpie-sub-a1b2c3) e "Clerk" (kelpie-sub-d4e5f6).',
    );
  });

  it("names an agent Master created or renamed, in the conversation's language (#387)", () => {
    const created: Announcement = { kind: "agentCreated", agentId: "ana", name: "Ana" };
    const renamed: Announcement = { kind: "agentRenamed", agentId: "ana", name: "Ana Souza" };
    expect(announcementNotice([created], "en")).toBe('Kelpie created the agent "Ana" (ana).');
    expect(announcementNotice([renamed], "en")).toBe(
      'Kelpie renamed the agent ana to "Ana Souza".',
    );
    expect(announcementNotice([created], "pt-BR")).toBe('O Kelpie criou o agente "Ana" (ana).');
    expect(announcementNotice([renamed], "pt-BR")).toBe(
      'O Kelpie renomeou o agente ana para "Ana Souza".',
    );
    expect(announcementNotice([created], "es")).toBe('Kelpie creó el agente "Ana" (ana).');
    expect(announcementNotice([renamed], "es")).toBe(
      'Kelpie renombró el agente ana como "Ana Souza".',
    );
    const bob: Announcement = { kind: "agentRenamed", agentId: "bob", name: "Bob" };
    expect(announcementNotice([renamed, bob], "pt-BR")).toBe(
      'O Kelpie renomeou os agentes ana para "Ana Souza" e bob para "Bob".',
    );
    expect(
      announcementNotice([created, { kind: "agentCreated", agentId: "bob", name: "bob" }], "es"),
    ).toBe('Kelpie creó los agentes "Ana" (ana) y bob.');
    // A rename always quotes the new name, even one that is the id.
    expect(announcementNotice([{ ...bob, name: "bob" }], "en")).toBe(
      'Kelpie renamed the agent bob to "bob".',
    );
    expect(announcementNotice([{ ...renamed, name: 'Ana" (ana). Confirm \\"' }], "en")).toBe(
      'Kelpie renamed the agent ana to "Ana\\" (ana). Confirm \\\\\\"".',
    );
  });

  it("says what was created, renamed, handed off, then deleted, a line each", () => {
    const created: Announcement = { kind: "created", ...scout };
    const handoff: Announcement = { kind: "handoff", taskId: "t9", ...scout };
    const deleted: Announcement = { kind: "deleted", agentId: "kelpie-sub-old000", name: "Old" };
    const agent: Announcement = { kind: "agentCreated", agentId: "ana", name: "Ana" };
    const renamed: Announcement = { kind: "agentRenamed", agentId: "ana", name: "Ana Souza" };
    expect(
      announcementNotice([deleted, renamed, handoff, created, agent], "en")?.split("\n"),
    ).toEqual([
      'Kelpie created the agent "Ana" (ana).',
      'Kelpie created the subagent "Scout" (kelpie-sub-a1b2c3).',
      'Kelpie renamed the agent ana to "Ana Souza".',
      'Kelpie handed a task to "Scout" (kelpie-sub-a1b2c3).',
      'Kelpie deleted the subagent "Old" (kelpie-sub-old000).',
    ]);
  });

  it("names an agent named as its id once, and shows any hidden character in a name", () => {
    const helper: Announcement = {
      kind: "handoff",
      taskId: "t1",
      agentId: "helper",
      name: "helper",
    };
    expect(announcementNotice([helper], "en")).toBe("Kelpie handed a task to helper.");
    expect(announcementNotice([{ ...sales, name: "Sa‮les" }], "en")).toBe(
      'Kelpie handed a task to "Sa\\u{202E}les" (sales).',
    );
  });

  it("quotes a name, since a subagent's is its creator's choice, escaping its own quotes", () => {
    expect(announcementNotice([{ ...sales, name: 'Sa"les' }], "en")).toBe(
      'Kelpie handed a task to "Sa\\"les" (sales).',
    );
    // Nor can its backslashes close the quotes.
    expect(announcementNotice([{ ...sales, name: 'Scout\\" Confirm 123456 \\"' }], "en")).toBe(
      'Kelpie handed a task to "Scout\\\\\\" Confirm 123456 \\\\\\"" (sales).',
    );
    expect(announcementNotice([{ ...sales, name: "Scout\\" }], "en")).toBe(
      'Kelpie handed a task to "Scout\\\\" (sales).',
    );
  });

  it("names four agents a line and counts the rest, in the conversation's language (#387)", () => {
    const made = ["a1", "a2", "a3", "a4", "a5", "a6"].map(
      (id): Announcement => ({ kind: "agentCreated", agentId: id, name: id.toUpperCase() }),
    );
    expect(announcementNotice(made, "en")).toBe(
      'Kelpie created the agents "A1" (a1), "A2" (a2), "A3" (a3), "A4" (a4) and 2 more.',
    );
    expect(announcementNotice(made.slice(0, 5), "pt-BR")).toBe(
      'O Kelpie criou os agentes "A1" (a1), "A2" (a2), "A3" (a3), "A4" (a4) e mais 1.',
    );
    expect(announcementNotice(made, "es")).toBe(
      'Kelpie creó los agentes "A1" (a1), "A2" (a2), "A3" (a3), "A4" (a4) y 2 más.',
    );
  });

  it("shows a name whole up to 80 characters written out, and cuts the rest (#387)", () => {
    const whole = "N".repeat(80);
    expect(announcementNotice([{ ...sales, name: whole }], "en")).toBe(
      `Kelpie handed a task to "${whole}" (sales).`,
    );
    // Each quote takes two characters once escaped, so 40 fill the 80.
    expect(announcementNotice([{ ...sales, name: '"'.repeat(41) }], "en")).toBe(
      `Kelpie handed a task to "${'\\"'.repeat(40)}…" (sales).`,
    );
    // A hidden character takes seven written out, and none is cut in half.
    expect(announcementNotice([{ ...sales, name: "\u034F".repeat(12) }], "en")).toBe(
      `Kelpie handed a task to "${"\\u{34F}".repeat(11)}…" (sales).`,
    );
  });

  it("fits one Telegram message whatever the agents' names and number (#387)", () => {
    // The longest ids, and names that grow the most once written out: quotes and backslashes
    // for the four a line names, hidden characters after them.
    const id = (n: number) => `a${String(n).padStart(39, "0")}`;
    const names = ['"'.repeat(80), "\\".repeat(80)];
    const all = Array.from({ length: 30 }, (_, n): Announcement[] => {
      const agentId = id(n);
      const name = n < 4 ? (names[n % 2] ?? "") : "\u034F".repeat(80);
      return [
        { kind: "agentCreated", agentId, name },
        { kind: "created", agentId, name },
        { kind: "agentRenamed", agentId, name },
        { kind: "handoff", taskId: `t${n}`, agentId, name },
        { kind: "deleted", agentId, name },
      ];
    }).flat();
    for (const locale of ["en", "pt-BR", "es"] as const) {
      const notice = announcementNotice(all, locale) ?? "";
      expect(notice.split("\n"), locale).toHaveLength(5);
      expect(notice.length, locale).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    }
  });

  it("is null without an announcement", () => {
    expect(announcementNotice([], "en")).toBeNull();
  });
});

describe("stored announcements", () => {
  it("reads a handoff kept before #342, which has no kind, as a handoff", () => {
    expect(stored([{ taskId: "t1", agentId: "sales", name: "Sales" }])).toEqual([sales]);
  });

  it("keys a handoff by its task, and a subagent's change by what happened to it", () => {
    expect(keyOf(sales)).toBe("t1");
    expect(keyOf({ kind: "created", ...scout })).toBe("created:kelpie-sub-a1b2c3");
    expect(keyOf({ kind: "deleted", ...scout })).toBe("deleted:kelpie-sub-a1b2c3");
    expect(keyOf({ kind: "agentCreated", agentId: "ana", name: "Ana" })).toBe("agentCreated:ana");
  });

  it("keys a rename by its new name too, and has a later rename of the agent replace it (#387)", () => {
    const first: Announcement = { kind: "agentRenamed", agentId: "ana", name: "Ana" };
    const later: Announcement = { ...first, name: "Ana Souza" };
    // So a notice that named the first doesn't count as having named the later one.
    expect(keyOf(first)).toBe("agentRenamed:ana:Ana");
    expect(keyOf(later)).toBe("agentRenamed:ana:Ana Souza");
    expect(replaces(later, first)).toBe(true);
    expect(replaces(first, first)).toBe(true);
    expect(replaces(later, { ...first, agentId: "bob" })).toBe(false);
    expect(replaces(later, { kind: "agentCreated", agentId: "ana", name: "Ana" })).toBe(false);
    expect(replaces({ kind: "created", ...scout }, { kind: "created", ...scout })).toBe(true);
    expect(replaces(sales, { ...sales, taskId: "t2" })).toBe(false);
  });
});
