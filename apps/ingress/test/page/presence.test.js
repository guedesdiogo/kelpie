import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_AFTER_MS,
  PresenceLink,
  rowAfter,
  rowAt,
  rowLine,
  UNKNOWN,
} from "../../public/webchat/presence.js";
import { TEXTS } from "../../public/webchat/texts.js";
import { FakeSocket } from "./harness.js";

// A sidebar row follows its agent through a presence socket (ADR-0052): its state comes only from
// the frames that view allows, it starts unknown, and it shows Offline 2 s after its socket closes.

const T = TEXTS.en;
const NOW = new Date(2026, 9, 16, 14, 32).getTime();

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

describe("a row's state", () => {
  it("starts unknown, never idle, until its presence frame arrives", () => {
    expect(UNKNOWN.state).toBe("unknown");
    expect(rowLine(UNKNOWN, T, NOW)).toEqual({ glyph: null, label: "", detail: "", time: "" });
    expect(rowAfter(UNKNOWN, { type: "status", status: "thinking" }, NOW).state).toBe("unknown");
    expect(rowAfter(UNKNOWN, presence(), NOW).state).toBe("idle");
  });

  it("works with the step and its label, timed from the turn's start", () => {
    const turn = { agoMs: 75_000, step: "tool", label: "Reading the calendar" };
    const row = rowAfter(UNKNOWN, presence({ turn }), NOW);
    expect(row).toMatchObject({
      state: "working",
      label: "Reading the calendar",
      since: NOW - 75_000,
    });
    expect(rowLine(row, T, NOW)).toEqual({
      glyph: "working",
      label: "working",
      detail: "Reading the calendar",
      time: "1:15",
    });
    const next = rowAfter(row, { type: "status", status: "thinking" }, NOW + 1_000);
    expect(next).toMatchObject({ state: "working", label: null, since: NOW - 75_000 });
    expect(rowLine(next, T, NOW + 1_000).detail).toBe("Thinking");
    expect(rowAfter(next, { type: "status", status: "idle" }, NOW + 2_000).state).toBe("idle");
  });

  it("counts in minutes only under less motion", () => {
    const row = rowAfter(UNKNOWN, presence({ turn: { agoMs: 134_000, step: "thinking" } }), NOW);
    expect(rowLine(row, T, NOW, { less: true }).time).toBe("2 min");
    expect(rowLine(row, T, NOW - 120_000, { less: true }).time).toBe("1 min");
  });

  it("starts the clock at the first step of a turn it saw begin", () => {
    const row = rowAfter(
      rowAfter(UNKNOWN, presence(), NOW),
      { type: "status", status: "memory" },
      NOW,
    );
    expect(rowLine(row, T, NOW + 4_000)).toMatchObject({ detail: "Reading memory", time: "0:04" });
    // A turn whose first step isn't known yet still works.
    expect(
      rowLine(rowAfter(UNKNOWN, presence({ turn: { agoMs: 0, step: null } }), NOW), T, NOW),
    ).toEqual({
      glyph: "working",
      label: "working",
      detail: "",
      time: "0:00",
    });
  });

  it("waits for the owner while a request is open, above work and errors, timed from the ask", () => {
    const row = rowAfter(
      UNKNOWN,
      presence({
        failed: true,
        paused: true,
        requests: [asked()],
        turn: { agoMs: 1, step: "thinking" },
      }),
      NOW,
    );
    expect(row.state).toBe("waiting");
    expect(rowLine(row, T, NOW)).toEqual({
      glyph: "waiting",
      label: "waiting for you",
      detail: "Create the event.",
      time: "3 min ago",
    });
    // Work goes on beside it, and the request still wins.
    expect(rowAfter(row, { type: "status", status: "tool", label: "Searching" }, NOW).state).toBe(
      "waiting",
    );
    // Answered, the row goes back to what the conversation does.
    const done = rowAfter(row, { type: "requests", requests: [], more: 0 }, NOW);
    expect(done.state).toBe("working");
  });

  it("names the newest request, and says now under a minute", () => {
    const row = rowAfter(
      UNKNOWN,
      presence({
        requests: [asked({ id: 9, summary: "Send the invite.", askedAgoMs: 20_000 }), asked()],
      }),
      NOW,
    );
    expect(rowLine(row, T, NOW)).toMatchObject({ detail: "Send the invite.", time: "now" });
  });

  it("stops waiting once its requests expire, with no frame to say so", () => {
    const row = rowAfter(UNKNOWN, presence({ requests: [asked({ expiresInMs: 60_000 })] }), NOW);
    expect(row.state).toBe("waiting");
    expect(rowAt(row, NOW + 59_999).state).toBe("waiting");
    expect(rowAt(row, NOW + 60_000).state).toBe("idle");
  });

  it("shows the pause, below work, until it is resumed", () => {
    const row = rowAfter(UNKNOWN, presence({ paused: true, failed: true }), NOW);
    expect(rowLine(row, T, NOW)).toEqual({
      glyph: "paused",
      label: "paused",
      detail: "",
      time: "",
    });
    expect(rowAfter(row, { type: "status", status: "thinking" }, NOW).state).toBe("working");
    expect(rowAfter(row, { type: "resumed" }, NOW).state).toBe("error");
    expect(rowAfter(rowAfter(UNKNOWN, presence(), NOW), { type: "paused" }, NOW).state).toBe(
      "paused",
    );
  });

  it("shows an error for a failed turn, until the next step", () => {
    const working = rowAfter(UNKNOWN, presence({ turn: { agoMs: 1, step: "thinking" } }), NOW);
    const failed = rowAfter(working, { type: "failed" }, NOW);
    expect(rowLine(failed, T, NOW)).toEqual({
      glyph: "error",
      label: "didn't answer",
      detail: "",
      time: "",
    });
    expect(rowAfter(failed, { type: "status", status: "thinking" }, NOW).state).toBe("working");
  });

  it("says no connection with no time, whatever it showed", () => {
    const working = rowAfter(UNKNOWN, presence({ requests: [asked()] }), NOW);
    const row = rowAfter(working, { type: "offline" }, NOW);
    expect(rowLine(row, T, NOW)).toEqual({
      glyph: "offline",
      label: "no connection",
      detail: "",
      time: "",
    });
    // Its next presence frame brings it back.
    expect(rowAfter(row, presence(), NOW).state).toBe("idle");
  });

  it("reads idle with what it does", () => {
    expect(rowLine(rowAfter(UNKNOWN, presence(), NOW), T, NOW)).toEqual({
      glyph: "idle",
      label: "idle",
      detail: "no task",
      time: "",
    });
  });

  it("ignores what a press did, which the card shows", () => {
    const row = rowAfter(UNKNOWN, presence({ requests: [asked()] }), NOW);
    expect(rowAfter(row, { type: "confirmation", id: 7, status: "accepted" }, NOW)).toBe(row);
  });
});

describe("a row's presence socket", () => {
  let hidden;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
    FakeSocket.all = [];
    globalThis.WebSocket = FakeSocket;
    hidden = false;
  });
  afterEach(() => vi.useRealTimers());

  function link() {
    const frames = [];
    const refused = vi.fn();
    const presenceLink = new PresenceLink("agenda", {
      host: "kelpie.test",
      lang: "en",
      onFrame: (frame) => frames.push(frame),
      onRefused: refused,
      isHidden: () => hidden,
      random: () => 1,
    });
    presenceLink.open();
    return { presenceLink, frames, refused, socket: FakeSocket.last };
  }

  it("opens in the presence view and takes only that view's frames", () => {
    const { frames, socket } = link();
    expect(socket.url).toBe("wss://kelpie.test/webchat/ws?agent=agenda&view=presence&lang=en");
    socket.open();
    socket.receive(presence());
    socket.receive({ type: "history", messages: [{ role: "assistant", text: "secret" }] });
    socket.receive({ type: "bubble", text: "secret" });
    socket.receive({ type: "typing", active: true });
    socket.receive("not json");
    socket.receive({ type: "status", status: "thinking" });
    expect(frames.map((frame) => frame.type)).toEqual(["presence", "status"]);
  });

  it("opens over plain ws where the page is served without TLS", () => {
    new PresenceLink("agenda", {
      host: "localhost:8787",
      lang: "pt-BR",
      secure: false,
      onFrame() {},
      onRefused() {},
    }).open();
    expect(FakeSocket.last.url).toBe(
      "ws://localhost:8787/webchat/ws?agent=agenda&view=presence&lang=pt-BR",
    );
  });

  it("names its agent on a press and a pause, over its own socket", () => {
    const { presenceLink, socket } = link();
    expect(presenceLink.confirm(7)).toBe(false);
    socket.open();
    expect(presenceLink.confirm(7)).toBe(true);
    expect(presenceLink.pause()).toBe(true);
    expect(socket.sent).toEqual([
      { type: "confirm", id: 7, agent: "agenda" },
      { type: "pause", agent: "agenda" },
    ]);
  });

  it("retries with the backoff, and shows Offline 2 s after its socket closes", () => {
    const { frames, socket } = link();
    socket.open();
    socket.receive(presence());
    socket.close(1006);
    // With `random` at 1, the first retry waits 300 ms.
    vi.advanceTimersByTime(299);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(OFFLINE_AFTER_MS - 301);
    expect(frames.at(-1).type).toBe("presence");
    vi.advanceTimersByTime(1);
    expect(frames.at(-1)).toEqual({ type: "offline" });
  });

  it("shows no Offline when a retry brings its state back within 2 s", () => {
    const { frames, socket } = link();
    socket.open();
    socket.close(1006);
    vi.advanceTimersByTime(300);
    FakeSocket.last.open();
    FakeSocket.last.receive(presence());
    vi.advanceTimersByTime(60_000);
    expect(frames.map((frame) => frame.type)).toEqual(["presence"]);
  });

  it("backs off further for each socket that dies at once", () => {
    const { socket } = link();
    socket.open();
    socket.close(1006);
    vi.advanceTimersByTime(300);
    FakeSocket.last.open();
    FakeSocket.last.close(1006);
    vi.advanceTimersByTime(599);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("doesn't retry a refusal, or a socket that never opened: the page reloads its list", () => {
    const first = link();
    first.socket.close(1006);
    expect(first.refused).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(first.frames).toEqual([{ type: "offline" }]);

    FakeSocket.all = [];
    const second = link();
    second.socket.open();
    second.socket.close(1008);
    expect(second.refused).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    // Still listed, the page retries it with the backoff.
    second.presenceLink.retry();
    vi.advanceTimersByTime(300);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("waits for a reconnect after the conversation's cap closed it", () => {
    const { presenceLink, refused, socket } = link();
    socket.open();
    socket.close(1013);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(refused).not.toHaveBeenCalled();
    presenceLink.reconnect();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("starts the backoff again on a reconnect", () => {
    const { presenceLink, socket } = link();
    socket.open();
    socket.close(1006);
    vi.advanceTimersByTime(300);
    FakeSocket.last.open();
    FakeSocket.last.close(1006);
    // The second retry would wait 600 ms; the page's own socket came back first.
    presenceLink.reconnect();
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("holds its retries while the page is hidden", () => {
    const { presenceLink, socket } = link();
    socket.open();
    hidden = true;
    socket.close(1006);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    hidden = false;
    presenceLink.wake();
    expect(FakeSocket.all).toHaveLength(2);
    // A wake with no retry due opens nothing.
    presenceLink.wake();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("goes quiet once closed, as a row leaves the list", () => {
    const { presenceLink, frames, refused, socket } = link();
    socket.open();
    presenceLink.close();
    expect(socket.readyState).toBe(3);
    socket.receive(presence());
    vi.advanceTimersByTime(60_000);
    expect(frames).toEqual([]);
    expect(refused).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);
  });
});
