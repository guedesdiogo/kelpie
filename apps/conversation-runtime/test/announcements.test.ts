import { describe, expect, it } from "vitest";
import { type Announcement, announcementNotice, keyOf, stored } from "../src/announcements.ts";

// Kelpie's notices of what a turn's tools did (ADR-0036 §4 and §6): a handoff names who has the
// work (#287), and a subagent created or deleted is named too (#342), by name and id, in the
// conversation's language.

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

  it("says what was created, then handed off, then deleted, a line each", () => {
    const created: Announcement = { kind: "created", ...scout };
    const handoff: Announcement = { kind: "handoff", taskId: "t9", ...scout };
    const deleted: Announcement = { kind: "deleted", agentId: "kelpie-sub-old000", name: "Old" };
    expect(announcementNotice([deleted, handoff, created], "en")?.split("\n")).toEqual([
      'Kelpie created the subagent "Scout" (kelpie-sub-a1b2c3).',
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
  });
});
