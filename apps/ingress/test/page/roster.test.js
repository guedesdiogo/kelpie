import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESS_GUARD_MS } from "../../public/webchat/card.js";
import { setMotion } from "../../public/webchat/mascot.js";
import { FOLLOWED_AT_MOST, RECEIPT_SHOWN_MS, Roster } from "../../public/webchat/roster.js";
import { TEXTS } from "../../public/webchat/texts.js";
import { FakeSocket } from "./harness.js";

// The sidebar's roster (5.9, ADR-0052): a row per agent in the Registry's order, each following
// its agent, the open one through the conversation's own socket.

const NOW = vi.hoisted(() => {
  const now = new Date(2026, 9, 16, 14, 32).getTime();
  // Before mascot.js loads, so the one timer it starts for every mascot is a fake one too.
  vi.useFakeTimers({
    now,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  return now;
});

const KELPIE = {
  shape: "mark",
  color: "kelp",
  eyes: "big",
  cheeks: false,
  head: { type: "ears", variation: "round" },
  accessory: { type: "none" },
};

const AGENTS = [
  { id: "assistant", name: "Kelpie", main: true, mascot: KELPIE },
  { id: "agenda", name: "Agenda", main: false, mascot: { ...KELPIE, color: "lagoon" } },
  { id: "pesquisa", name: "Pesquisa", main: false },
];

const presence = (over = {}) => ({
  type: "presence",
  turn: null,
  failed: false,
  paused: false,
  requests: [],
  more: 0,
  ...over,
});

const asked = (over = {}) => ({
  id: 7,
  summary: "Create the event.",
  askedAgoMs: 180_000,
  expiresInMs: 420_000,
  ...over,
});

let roster;
let nav;
let strip;
let note;
let waiting;
let refused;
let openOwnCard;

function make(agents = AGENTS, current = "assistant") {
  document.body.innerHTML =
    '<p class="strip" hidden></p><nav aria-label="Agents"><ul></ul></nav><p class="note" hidden></p>';
  nav = document.querySelector("nav");
  strip = document.querySelector(".strip");
  note = document.querySelector(".note");
  waiting = [];
  refused = vi.fn();
  openOwnCard = vi.fn(() => true);
  roster = new Roster(nav, {
    texts: TEXTS.en,
    locale: "en",
    strip,
    note,
    socket: {
      host: "kelpie.test",
      lang: "en",
      secure: true,
      isHidden: () => false,
      random: () => 1,
    },
    less: () => false,
    onWaiting: (count) => waiting.push(count),
    onRefused: refused,
    onAnnounce: () => {},
    openOwnCard,
  });
  roster.setAgents(agents, current);
}

const rowOf = (name) =>
  [...nav.querySelectorAll(".roster-row")].find(
    (row) => row.querySelector(".row-link").textContent === name,
  );
const lineOf = (name) => {
  const row = rowOf(name);
  return {
    state: row.dataset.state,
    glyph: row.querySelector(".glyph")?.dataset.glyph ?? null,
    // What shows: a label that rolled out may still be leaving.
    label: row.querySelector(".lbl .roll:last-child")?.textContent ?? "",
    detail: row.querySelector(".det").textContent,
    time: row.querySelector(".atime").textContent,
  };
};
const opened = (agent) => {
  const socket = FakeSocket.presence(agent);
  socket.open();
  return socket;
};

beforeEach(() => {
  vi.useFakeTimers({
    now: NOW,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  setMotion("still");
});
afterEach(() => vi.useRealTimers());

describe("the roster's rows", () => {
  it("lists every agent in the Registry's order, each a link to its conversation", () => {
    make();
    const links = [...nav.querySelectorAll(".row-link")];
    expect(links.map((link) => link.textContent)).toEqual(["Kelpie", "Agenda", "Pesquisa"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "?agent=assistant",
      "?agent=agenda",
      "?agent=pesquisa",
    ]);
    expect(links[0].getAttribute("aria-current")).toBe("page");
    expect(links[1].hasAttribute("aria-current")).toBe(false);
    // Each agent's own mascot at 36 px, before its socket opens; one with none keeps its box.
    expect(rowOf("Agenda").querySelector(".mascot-host svg").getAttribute("width")).toBe("36");
    expect(rowOf("Pesquisa").querySelector(".mascot-host").childElementCount).toBe(0);
  });

  it("opens a presence socket for every agent but the one the page shows", () => {
    make();
    expect(FakeSocket.all.map((socket) => socket.url)).toEqual([
      "wss://kelpie.test/webchat/ws?agent=agenda&view=presence&lang=en",
      "wss://kelpie.test/webchat/ws?agent=pesquisa&view=presence&lang=en",
    ]);
  });

  it("shows no state before its presence frame, then its line", () => {
    make();
    expect(lineOf("Agenda")).toEqual({
      state: "unknown",
      glyph: null,
      label: "",
      detail: "",
      time: "",
    });
    opened("agenda").receive(
      presence({ turn: { agoMs: 4_000, step: "tool", label: "Searching the web" } }),
    );
    expect(lineOf("Agenda")).toEqual({
      state: "working",
      glyph: "working",
      label: "working",
      detail: " · Searching the web",
      time: "0:04",
    });
    // Its time counts while it works.
    vi.advanceTimersByTime(1_000);
    expect(lineOf("Agenda").time).toBe("0:05");
    expect(rowOf("Agenda").querySelector(".mascot-host").mascot.state).toBe("working");
  });

  it("never reorders when a state changes", () => {
    make();
    opened("pesquisa").receive(presence({ requests: [asked()] }));
    opened("agenda").receive(presence());
    expect([...nav.querySelectorAll(".row-link")].map((link) => link.textContent)).toEqual([
      "Kelpie",
      "Agenda",
      "Pesquisa",
    ]);
  });

  it("follows the open conversation through its own socket", () => {
    make();
    roster.own({ type: "history", messages: [], received: [], paused: false });
    expect(lineOf("Kelpie")).toMatchObject({ state: "idle", label: "idle", detail: " · no task" });
    roster.own({ type: "status", status: "thinking" });
    expect(lineOf("Kelpie")).toMatchObject({ state: "working", detail: " · Thinking" });
    roster.own({ type: "typing", active: true });
    expect(lineOf("Kelpie").detail).toBe(" · Typing");
    roster.own({ type: "bubble", text: "Done." });
    expect(lineOf("Kelpie").state).toBe("idle");
    roster.own({ type: "bubble", text: "No model answered.", failed: true });
    expect(lineOf("Kelpie")).toMatchObject({ state: "error", glyph: "error" });
    roster.own({ type: "requests", requests: [asked()], more: 0 });
    expect(lineOf("Kelpie").state).toBe("waiting");
  });

  it("follows at most 16 agents, and says so once", () => {
    const many = Array.from({ length: FOLLOWED_AT_MOST + 2 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      main: index === 0,
    }));
    make(many, "agent-0");
    expect(FakeSocket.all).toHaveLength(FOLLOWED_AT_MOST);
    expect(FakeSocket.all.at(-1).url).toContain(`agent=agent-${FOLLOWED_AT_MOST}&`);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("The sidebar follows the first 16 agents only.");
    expect(lineOf(`Agent ${FOLLOWED_AT_MOST + 1}`).state).toBe("unknown");
  });
});

describe("what waits for the owner", () => {
  it("counts the waiting agents in the strip, which leaves when none waits", async () => {
    make();
    expect(strip.hidden).toBe(true);
    const agenda = opened("agenda");
    agenda.receive(presence({ requests: [asked()] }));
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toBe("1 agent waiting for you");
    expect(lineOf("Agenda")).toMatchObject({
      glyph: "waiting",
      label: "waiting for you",
      detail: " · Create the event.",
      time: "3 min ago",
    });
    opened("pesquisa").receive(presence({ requests: [asked({ id: 2 })] }));
    expect(strip.querySelector(".count .roll:last-child").textContent).toBe("2");
    expect(strip.querySelector(".words").textContent).toBe(" agents waiting for you");
    agenda.receive({ type: "requests", requests: [], more: 0 });
    FakeSocket.presence("pesquisa").receive({ type: "requests", requests: [], more: 0 });
    expect(waiting).toEqual([1, 2, 1, 0]);
    await vi.waitFor(() => expect(strip.hidden).toBe(true));
  });

  it("opens a waiting row's request under it, and confirms over that row's socket", async () => {
    make();
    const agenda = opened("agenda");
    agenda.receive(presence({ requests: [asked()] }));
    const open = rowOf("Agenda").querySelector(".row-open");
    expect(open.hidden).toBe(false);
    expect(open.getAttribute("aria-expanded")).toBe("false");
    open.click();
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const card = rowOf("Agenda").querySelector(".row-request .bubble.card");
    expect(card.querySelector(".card-who").textContent).toBe("Agenda asks you to confirm");
    expect(card.querySelector(".text").textContent).toBe("Create the event.");
    expect(card.querySelector(".card-until").textContent).toBe("Valid until 2:39 PM");
    vi.advanceTimersByTime(PRESS_GUARD_MS);
    card.querySelector("button.confirm").dispatchEvent(new MouseEvent("click", { detail: 1 }));
    expect(agenda.sent).toEqual([{ type: "confirm", id: 7, agent: "agenda" }]);
    agenda.receive({ type: "confirmation", id: 7, status: "accepted" });
    expect(card.dataset.state).toBe("done");
    expect(rowOf("Agenda").querySelector(".mascot-host").mascot.state).toBe("approved");
    agenda.receive({ type: "requests", requests: [], more: 0 });
    // The receipt shows a moment, then the request closes.
    vi.advanceTimersByTime(1_000);
    await vi.waitFor(() => expect(card.querySelector(".receipt")).not.toBeNull());
    vi.advanceTimersByTime(RECEIPT_SHOWN_MS);
    expect(rowOf("Agenda").querySelector(".row-request").hidden).toBe(true);
    expect(lineOf("Agenda").state).toBe("idle");
  });

  it("closes a request answered somewhere else", () => {
    make();
    const agenda = opened("agenda");
    agenda.receive(presence({ requests: [asked()] }));
    rowOf("Agenda").querySelector(".row-open").click();
    agenda.receive({ type: "requests", requests: [], more: 0 });
    expect(rowOf("Agenda").querySelector(".row-request").hidden).toBe(true);
  });

  it("goes to the open conversation's card in its thread", () => {
    make();
    roster.own({ type: "history", messages: [], received: [], paused: false });
    roster.own({ type: "requests", requests: [asked()], more: 0 });
    rowOf("Kelpie").querySelector(".row-open").click();
    expect(openOwnCard).toHaveBeenCalledOnce();
    expect(rowOf("Kelpie").querySelector(".row-request").hidden).toBe(true);
  });
});

describe("the keyboard", () => {
  it("is one tab stop that the arrows, Home and End move", () => {
    make();
    const links = [...nav.querySelectorAll(".row-link")];
    expect(links.map((link) => link.tabIndex)).toEqual([0, -1, -1]);
    links[0].focus();
    const press = (key) =>
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    press("ArrowDown");
    expect(document.activeElement).toBe(links[1]);
    expect(links.map((link) => link.tabIndex)).toEqual([-1, 0, -1]);
    press("End");
    expect(document.activeElement).toBe(links[2]);
    press("ArrowDown");
    expect(document.activeElement).toBe(links[2]);
    press("Home");
    expect(document.activeElement).toBe(links[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(links[0]);
  });

  it("opens a waiting row's request with →, at once, and closes it with ← or Escape", () => {
    make();
    opened("agenda").receive(presence({ requests: [asked()] }));
    const link = rowOf("Agenda").querySelector(".row-link");
    link.focus();
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const request = rowOf("Agenda").querySelector(".row-request");
    expect(request.hidden).toBe(false);
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(request.hidden).toBe(true);
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const confirm = request.querySelector("button.confirm");
    confirm.focus();
    confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(request.hidden).toBe(true);
    expect(document.activeElement).toBe(link);
  });

  it("does nothing on → for a row that doesn't wait", () => {
    make();
    opened("agenda").receive(presence());
    const link = rowOf("Agenda").querySelector(".row-link");
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(rowOf("Agenda").querySelector(".row-request").hidden).toBe(true);
  });
});

describe("a lost connection", () => {
  it("says no connection on every row while the page's own socket is lost", () => {
    make();
    const agenda = opened("agenda");
    agenda.receive(presence({ requests: [asked()] }));
    roster.offline(true);
    expect(lineOf("Agenda")).toMatchObject({
      state: "offline",
      glyph: "offline",
      label: "no connection",
    });
    expect(lineOf("Kelpie").state).toBe("offline");
    expect(strip.dataset.leaving).toBe("");
    // What arrives meanwhile still counts once the page is back.
    agenda.receive({ type: "requests", requests: [], more: 0 });
    roster.offline(false);
    expect(lineOf("Agenda").state).toBe("idle");
  });

  it("shows one row's Offline 2 s after its own socket closes", () => {
    make();
    const agenda = opened("agenda");
    agenda.receive(presence());
    agenda.close(1006);
    vi.advanceTimersByTime(2_000);
    expect(lineOf("Agenda").state).toBe("offline");
    expect(lineOf("Pesquisa").state).toBe("unknown");
  });

  it("asks once for the list when rows are refused, and keeps only the rows it names", () => {
    make();
    FakeSocket.presence("agenda").close(1006);
    FakeSocket.presence("pesquisa").close(1006);
    vi.advanceTimersByTime(0);
    expect(refused).toHaveBeenCalledOnce();
    roster.setAgents([AGENTS[0], AGENTS[1]], "assistant");
    expect([...nav.querySelectorAll(".row-link")].map((link) => link.textContent)).toEqual([
      "Kelpie",
      "Agenda",
    ]);
    // The row still listed retries with the backoff.
    vi.advanceTimersByTime(300);
    expect(FakeSocket.all.filter((socket) => socket.url.includes("agent=agenda&"))).toHaveLength(2);
  });

  it("restarts every row's backoff when the page's own socket is back", () => {
    make();
    const agenda = opened("agenda");
    agenda.close(1013);
    roster.reconnect();
    expect(FakeSocket.presence("agenda")).not.toBe(agenda);
  });
});
