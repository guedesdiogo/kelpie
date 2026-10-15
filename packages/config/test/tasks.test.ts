import { describe, expect, it } from "vitest";
import {
  isTaskId,
  parseCommentText,
  parseNewTask,
  parseRunOutcome,
  parseTaskEdit,
} from "../src/tasks.ts";

const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 24 * 60 * 60_000;

describe("task inputs (#54)", () => {
  it("takes a new task's title, body, status and scheduled start, Backlog by default", () => {
    expect(parseNewTask({ title: "  Book the flights  " }, NOW)).toEqual({
      title: "Book the flights",
      body: "",
      status: "backlog",
      scheduledStartAt: null,
    });
    expect(
      parseNewTask(
        { title: "Report", body: "Weekly.\nShort.", status: "todo", scheduledStartAt: NOW + DAY },
        NOW,
      ),
    ).toEqual({
      title: "Report",
      body: "Weekly.\nShort.",
      status: "todo",
      scheduledStartAt: NOW + DAY,
    });
  });

  it("refuses a new task people can't create, or values out of bounds", () => {
    for (const input of [
      null,
      "Book",
      {},
      { title: "" },
      { title: "   " },
      { title: "a".repeat(201) },
      { title: "Two\nlines" },
      { title: "Book", body: 7 },
      { title: "Book", body: "a".repeat(20_001) },
      // People create in Backlog or To do only (ADR-0011).
      { title: "Book", status: "in_progress" },
      { title: "Book", status: "done" },
      { title: "Book", scheduledStartAt: "tomorrow" },
      { title: "Book", scheduledStartAt: 1.5 },
      { title: "Book", scheduledStartAt: 0 },
      { title: "Book", scheduledStartAt: NOW + 367 * DAY },
      { title: "Book", owner: "someone" },
    ]) {
      expect(parseNewTask(input, NOW), JSON.stringify(input)).toBeNull();
    }
    // A start already past is eligible at once.
    expect(parseNewTask({ title: "Book", scheduledStartAt: NOW - DAY }, NOW)).toMatchObject({
      scheduledStartAt: NOW - DAY,
    });
  });

  it("takes an edit of the title, body or scheduled start, and clears the start with null", () => {
    expect(parseTaskEdit({ title: "New" }, NOW)).toEqual({ title: "New" });
    expect(parseTaskEdit({ body: "", scheduledStartAt: null }, NOW)).toEqual({
      body: "",
      scheduledStartAt: null,
    });
    for (const input of [{}, null, { status: "todo" }, { title: "" }, { scheduledStartAt: -1 }]) {
      expect(parseTaskEdit(input, NOW), JSON.stringify(input)).toBeNull();
    }
  });

  it("takes a comment of one to 8,000 characters", () => {
    expect(parseCommentText("  On it.\nSoon.  ")).toBe("On it.\nSoon.");
    for (const text of ["", "   ", 7, null, "a".repeat(8_001)]) {
      expect(parseCommentText(text)).toBeNull();
    }
  });

  it("takes a run's end: Done needs a result", () => {
    expect(parseRunOutcome({ status: "done", result: " Booked. " })).toEqual({
      status: "done",
      result: "Booked.",
    });
    expect(parseRunOutcome({ status: "waiting", reason: "needs_input" })).toEqual({
      status: "waiting",
      reason: "needs_input",
    });
    expect(parseRunOutcome({ status: "cancelled" })).toEqual({ status: "cancelled" });
    expect(parseRunOutcome({ status: "cancelled", result: "Stopped." })).toEqual({
      status: "cancelled",
      result: "Stopped.",
    });
    expect(parseRunOutcome({ status: "failed" })).toEqual({ status: "failed" });
    for (const input of [
      { status: "done" },
      { status: "done", result: "  " },
      { status: "waiting" },
      // Two failed attempts park a task; a run can't claim that reason for itself.
      { status: "waiting", reason: "failed" },
      { status: "in_progress" },
      { status: "done", result: "a".repeat(20_001) },
      null,
    ]) {
      expect(parseRunOutcome(input), JSON.stringify(input)).toBeNull();
    }
  });

  it("knows a task id by its form", () => {
    expect(isTaskId("0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f")).toBe(true);
    for (const id of ["", "task-1", "0F8B7C1E-6A2D-4C3B-9E5F-1A2B3C4D5E6F", 7, null]) {
      expect(isTaskId(id)).toBe(false);
    }
  });
});
