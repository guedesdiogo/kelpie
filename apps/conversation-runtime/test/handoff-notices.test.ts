import { describe, expect, it } from "vitest";
import { handoffNotice } from "../src/handoff-notices.ts";

// Kelpie's notice of a handoff (ADR-0036 §4, #287): it names who has the work, by name and id, in
// the conversation's language.

const sales = { taskId: "t1", agentId: "sales", name: "Sales" };
const travel = { taskId: "t2", agentId: "travel", name: "Viagens" };

describe("handoffNotice", () => {
  it("names the agent by its name and id, in the conversation's language", () => {
    expect(handoffNotice([sales], "en")).toBe("Kelpie handed a task to Sales (sales).");
    expect(handoffNotice([sales], "pt-BR")).toBe("O Kelpie passou uma tarefa para Sales (sales).");
    expect(handoffNotice([sales], "es")).toBe("Kelpie pasó una tarea a Sales (sales).");
  });

  it("names each agent once, however many tasks it got", () => {
    const again = { ...sales, taskId: "t3" };
    expect(handoffNotice([sales, travel, again], "en")).toBe(
      "Kelpie handed tasks to Sales (sales) and Viagens (travel).",
    );
    expect(handoffNotice([sales, again], "pt-BR")).toBe(
      "O Kelpie passou tarefas para Sales (sales).",
    );
    const third = { taskId: "t4", agentId: "docs", name: "Docs" };
    expect(handoffNotice([sales, travel, third], "es")).toBe(
      "Kelpie pasó tareas a Sales (sales), Viagens (travel) y Docs (docs).",
    );
  });

  it("names an agent named as its id once, and shows any hidden character in a name", () => {
    expect(handoffNotice([{ taskId: "t1", agentId: "helper", name: "helper" }], "en")).toBe(
      "Kelpie handed a task to helper.",
    );
    expect(handoffNotice([{ ...sales, name: "Sa‮les" }], "en")).toBe(
      "Kelpie handed a task to Sa\\u{202E}les (sales).",
    );
  });

  it("is null without a handoff", () => {
    expect(handoffNotice([], "en")).toBeNull();
  });
});
