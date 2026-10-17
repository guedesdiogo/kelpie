// The tab counts what waits for the owner (docs/design-system.md §5.9, issue #389): its title starts
// with the count, and the favicon gets its --warm dot. The count is the sidebar's strip: every agent
// with a confirmation open (ADR-0052), the open one through its own socket.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, FakeSocket, fakeFetch, historyFrame, loadPage, settle } from "./harness.js";

/** Thursday 15 October 2026, 14:32 in the browser's zone. */
const NOW = new Date(2026, 9, 15, 14, 32).getTime();

beforeEach(() => {
  vi.useFakeTimers({
    now: NOW,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The page, connected, with an empty history. */
async function opened(options) {
  const page = await loadPage(options);
  page.socket.open();
  page.socket.receive(historyFrame());
  vi.advanceTimersByTime(500);
  await settle();
  return page;
}

const favicon = () =>
  document.querySelector('link[rel="icon"][type="image/svg+xml"]').getAttribute("href");
const tab = () => [document.title, favicon()];
const open = (id) => ({ id, summary: "Change the tier?", askedAgoMs: 0, expiresInMs: 10 * 60_000 });
/** A notice, then the open list the conversation sends once it was sent. */
const notice = (socket, ...ids) => {
  for (const id of ids)
    socket.receive({ type: "bubble", text: "Change the tier?", confirmation: id });
  socket.receive({ type: "requests", requests: ids.map(open), more: 0 });
};
const answered = (socket, ...ids) =>
  socket.receive({ type: "requests", requests: ids.map(open), more: 0 });

const PLAIN = ["Assistant · Kelpie", "/webchat/icon.svg"];
const WAITING = ["(1) Assistant · Kelpie", "/webchat/icon-waiting.svg"];

describe("the tab (5.9)", () => {
  it("counts the open agent while its notice waits, until the owner confirms", async () => {
    const { socket } = await opened();
    expect(tab()).toEqual(PLAIN);
    notice(socket, 4);
    expect(tab()).toEqual(WAITING);
    // The ICO stays: browsers that change a favicon at runtime read the SVG.
    expect(document.querySelector('link[rel="icon"][sizes]').getAttribute("href")).toBe(
      "/webchat/favicon.ico",
    );

    vi.advanceTimersByTime(400);
    document
      .querySelector("button.confirm")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    // Pressed but not yet answered, it still waits.
    expect(tab()).toEqual(WAITING);
    socket.receive({ type: "confirmation", id: 4, status: "accepted" });
    answered(socket);
    expect(tab()).toEqual(PLAIN);
    // The approval's pose ends, and nothing waits.
    vi.advanceTimersByTime(1_100);
    expect(tab()).toEqual(PLAIN);
  });

  it("keeps the count while the owner looks, until the notice expires", async () => {
    const { socket } = await opened();
    notice(socket, 4);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(tab()).toEqual(WAITING);
    vi.advanceTimersByTime(1);
    expect(tab()).toEqual(PLAIN);
  });

  it("keeps counting a confirmation still open after the owner writes, as the strip does", async () => {
    const { socket } = await opened();
    notice(socket, 4);
    $("text").value = "Not now.";
    $("composer").requestSubmit();
    expect(socket.sentOf("message")).toHaveLength(1);
    expect(tab()).toEqual(WAITING);
  });

  it("counts another agent waiting, from its row in the sidebar", async () => {
    await opened();
    const agenda = FakeSocket.presence("agenda");
    agenda.open();
    agenda.receive({
      type: "presence",
      turn: null,
      failed: false,
      paused: false,
      requests: [open(9)],
      more: 0,
    });
    expect(tab()).toEqual(WAITING);
    agenda.receive({ type: "requests", requests: [], more: 0 });
    expect(tab()).toEqual(PLAIN);
  });

  it("clears once nothing is open, and when the page loses its connection", async () => {
    const { socket } = await opened();
    notice(socket, 4);
    socket.receive({ type: "confirmation", id: 4, status: "stale" });
    answered(socket);
    expect(tab()).toEqual(PLAIN);
    notice(socket, 5);
    expect(tab()).toEqual(WAITING);
    // Every row says no connection once the banner enters, 2 s later (5.12), and counts nothing.
    socket.close();
    vi.advanceTimersByTime(2_000);
    expect(tab()).toEqual(PLAIN);
  });

  it("writes the title and the favicon only when they change", async () => {
    const { socket } = await opened();
    notice(socket, 4);
    const changes = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    // A second confirmation from the same agent counts it once; the tab already says so.
    notice(socket, 5, 4);
    await settle();
    expect(changes).toEqual([]);
    expect(tab()).toEqual(WAITING);
    answered(socket);
    await settle();
    expect(changes.length).toBeGreaterThan(0);
    observer.disconnect();
  });

  it("names an agent called Kelpie once", async () => {
    const { socket } = await opened({
      search: "?agent=kelpie",
      fetch: fakeFetch({ agents: [{ id: "kelpie", name: "Kelpie", main: true }] }),
    });
    expect(tab()).toEqual(["Kelpie", "/webchat/icon.svg"]);
    notice(socket, 4);
    expect(tab()).toEqual(["(1) Kelpie", "/webchat/icon-waiting.svg"]);
  });
});
