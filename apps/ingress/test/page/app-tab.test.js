// The tab counts what waits for the owner (docs/design-system.md §5.9, issue #389): its title starts
// with the count, and the favicon gets its --warm dot. Today the page hears only the open agent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, fakeFetch, historyFrame, loadPage, settle } from "./harness.js";

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
const notice = (socket, id = 4) =>
  socket.receive({ type: "bubble", text: "Change the tier?", confirmation: id });

const PLAIN = ["Assistant · Kelpie", "/webchat/icon.svg"];
const WAITING = ["(1) Assistant · Kelpie", "/webchat/icon-waiting.svg"];

describe("the tab (5.9)", () => {
  it("counts the open agent while its notice waits, until the owner confirms", async () => {
    const { socket } = await opened();
    expect(tab()).toEqual(PLAIN);
    notice(socket);
    expect(tab()).toEqual(WAITING);
    // The ICO stays: browsers that change a favicon at runtime read the SVG.
    expect(document.querySelector('link[rel="icon"][sizes]').getAttribute("href")).toBe(
      "/webchat/favicon.ico",
    );

    document
      .querySelector("button.confirm")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    // Pressed but not yet answered, it still waits.
    expect(tab()).toEqual(WAITING);
    socket.receive({ type: "confirmation", id: 4, status: "accepted" });
    expect(tab()).toEqual(PLAIN);
    // The approval's pose ends, and nothing waits.
    vi.advanceTimersByTime(1_100);
    expect(tab()).toEqual(PLAIN);
  });

  it("keeps the count while the owner looks, until the notice expires", async () => {
    const { socket } = await opened();
    notice(socket);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(tab()).toEqual(WAITING);
    vi.advanceTimersByTime(1);
    expect(tab()).toEqual(PLAIN);
  });

  it("clears when the owner writes instead, as the mascot does", async () => {
    const { socket } = await opened();
    notice(socket);
    $("text").value = "Not now.";
    $("composer").requestSubmit();
    expect(socket.sentOf("message")).toHaveLength(1);
    expect(tab()).toEqual(PLAIN);
  });

  it("clears on a stale answer, and when the socket closes", async () => {
    const { socket } = await opened();
    notice(socket);
    socket.receive({ type: "confirmation", id: 4, status: "stale" });
    expect(tab()).toEqual(PLAIN);
    notice(socket, 5);
    expect(tab()).toEqual(WAITING);
    socket.close();
    expect(tab()).toEqual(PLAIN);
  });

  it("writes the title and the favicon only when they change", async () => {
    const { socket } = await opened();
    notice(socket);
    const changes = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    // A second notice renews the wait; the tab already says so.
    notice(socket, 5);
    await settle();
    expect(changes).toEqual([]);
    expect(tab()).toEqual(WAITING);
    socket.receive({ type: "confirmation", id: 5, status: "stale" });
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
    notice(socket);
    expect(tab()).toEqual(["(1) Kelpie", "/webchat/icon-waiting.svg"]);
  });
});
