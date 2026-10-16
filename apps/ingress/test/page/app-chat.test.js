import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, FakeSocket, historyFrame, loadPage, settle } from "./harness.js";

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

/** The page, connected, with `messages` replayed. */
async function opened(messages = []) {
  const page = await loadPage();
  page.socket.open();
  page.socket.receive(historyFrame(messages));
  vi.advanceTimersByTime(500);
  await settle();
  return page;
}

function type(text) {
  const input = $("text");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function enter(options = {}) {
  $("text").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options }),
  );
}

const marks = () => [...document.querySelectorAll(".mark")].map((mark) => mark.textContent);

describe("the conversation", () => {
  it("shows the history once loaded, announcing only that it loaded", async () => {
    const { socket, fetch } = await opened([
      { role: "user", text: "oi", at: NOW - 60_000 },
      { role: "assistant", text: "Olá.", at: NOW - 30_000 },
    ]);
    expect(socket.url).toBe("ws://localhost:3000/webchat/ws?agent=assistant&lang=en-US");
    expect(fetch).toHaveBeenCalledWith("/webchat/agents", {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      redirect: "manual",
      cache: "no-store",
    });
    expect($("thread").getAttribute("aria-busy")).toBe("false");
    expect($("thread").getAttribute("role")).toBe("log");
    expect($("thread").textContent).toContain("Olá.");
    expect($("announcer").textContent).toBe("Conversation loaded");
    expect($("agent-name").textContent).toBe("Assistant");
    // The groups' headings name the agent once the list arrives, whatever came first.
    expect(document.querySelector('.group[data-sender="assistant"] > h3').textContent).toMatch(
      /^Assistant, /,
    );
    // Connected, the header's line no longer says "Connecting".
    expect($("status").textContent).toBe("");
    expect(document.title).toBe("Assistant · Kelpie");
    expect($("version").textContent).toBe("Kelpie 1.2.3 · abc1234");
    expect($("skeleton").hidden).toBe(true);
    expect($("empty").hidden).toBe(true);
  });

  it("explains an empty conversation in one sentence", async () => {
    await opened([]);
    expect($("empty").hidden).toBe(false);
    expect($("empty-text").textContent).toBe(
      "No messages with Assistant yet. Write below to start.",
    );
    type("primeira");
    enter();
    expect($("empty").hidden).toBe(true);
  });

  it("sends with Enter, holds it during the wait, and the reply takes the typing bubble's place", async () => {
    const { socket } = await opened();
    type("então");
    expect(socket.sentOf("typing")).toEqual([{ type: "typing", active: true }]);
    enter();
    const [message] = socket.sentOf("message");
    expect(message).toMatchObject({ type: "message", text: "então" });
    expect($("text").value).toBe("");
    expect(socket.sentOf("typing").at(-1)).toEqual({ type: "typing", active: false });

    socket.receive({ type: "accepted", id: message.id });
    socket.receive({
      type: "wait",
      deadline: { remainingMs: 10_000, spanMs: 10_000, holding: false },
    });
    expect($("wait").hidden).toBe(false);
    expect($("wait-label").textContent).toBe("Waiting for you to finish");
    expect(marks()).toEqual(["Held"]);

    socket.receive({ type: "wait", deadline: null });
    // The demo's track says the agent writes until its reply comes (decision 10, #378).
    expect($("wait").hidden).toBe(false);
    expect($("wait").dataset.state).toBe("writing");
    expect($("wait-label").textContent).toBe("Assistant is writing");
    // "Held" fades out as the turn starts reading.
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => expect(marks()).toEqual([""]));
    const typing = document.querySelector(".bubble.typing");
    expect(typing).not.toBeNull();
    socket.receive({ type: "status", status: "thinking" });
    expect($("status").textContent).toBe("Thinking");
    socket.receive({ type: "status", status: "tool", label: "Searching memory" });
    expect($("status").textContent).toBe("Searching memory");
    expect(document.querySelector(".tool-row")).not.toBeNull();

    socket.receive({ type: "bubble", text: "Sim, está marcado." });
    expect($("wait").hidden).toBe(true);
    expect(document.querySelector(".bubble.typing")).toBeNull();
    expect(typing.textContent).toContain("Sim, está marcado.");
    expect($("announcer").textContent).toBe("Assistant: Sim, está marcado.");
    expect($("status").textContent).toBe("");
  });

  it("has one row: the text, then Pause and Send as round icon buttons that say their name", async () => {
    await opened();
    const row = $("text").parentElement;
    expect([...row.querySelectorAll("textarea, button")].map((element) => element.id)).toEqual([
      "text",
      "pause",
      "send",
    ]);
    expect($("pause").getAttribute("aria-label")).toBe("Pause");
    expect($("pause").getAttribute("aria-pressed")).toBe("false");
    expect($("send").getAttribute("aria-label")).toBe("Send");
    expect($("send").querySelector("svg")).not.toBeNull();
    expect($("send").querySelector(".tip").textContent).toBe("Send");
    // No keyboard hint on screen, and no `title` anywhere (#378).
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("keeps Enter for an input method and Shift+Enter, and sends nothing empty", async () => {
    const { socket } = await opened();
    type("ação");
    enter({ isComposing: true });
    enter({ keyCode: 229 });
    enter({ shiftKey: true });
    expect(socket.sentOf("message")).toEqual([]);
    type("   ");
    enter();
    expect(socket.sentOf("message")).toEqual([]);
    // Other keys in the box do nothing special.
    $("text").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });

  it("holds the bar full while the owner types during a hold, then drains it", async () => {
    const { socket } = await opened();
    const animate = vi.spyOn(Element.prototype, "animate");
    type("e mais");
    socket.receive({
      type: "wait",
      deadline: { remainingMs: 4_000, spanMs: 4_000, holding: true },
    });
    const fill = document.querySelector(".wait-fill");
    const held = animate.mock.calls.filter((_call, index) => animate.mock.contexts[index] === fill);
    expect(held.at(-1)[0].at(-1)).toEqual({ transform: "scaleX(1)" });
    vi.advanceTimersByTime(1_000);
    const drained = animate.mock.calls.filter((_, index) => animate.mock.contexts[index] === fill);
    expect(drained.at(-1)[0].at(-1)).toEqual({ transform: "scaleX(0)", offset: 1 });
    animate.mockRestore();
  });

  it("puts a refused message back in the box and says why", async () => {
    const { socket } = await opened();
    type("x".repeat(20));
    enter();
    const [message] = socket.sentOf("message");
    socket.receive({ type: "rejected", id: message.id, reason: "too_long" });
    expect($("text").value).toBe("x".repeat(20));
    expect(marks()).toEqual(["Not sent: too long"]);
    // A late frame with no message changes nothing.
    socket.receive({ type: "rejected", id: "unknown", reason: "empty" });
    socket.receive({ type: "accepted", id: "unknown" });
  });

  it("pauses, says how to resume, and resumes with the next message", async () => {
    const { socket } = await opened();
    socket.receive({
      type: "wait",
      deadline: { remainingMs: 9_000, spanMs: 10_000, holding: false },
    });
    $("pause").click();
    expect(socket.sentOf("pause")).toEqual([{ type: "pause", agent: "assistant" }]);
    socket.receive({ type: "paused" });
    expect($("paused-line").hidden).toBe(false);
    expect($("paused-line").textContent).toBe("Paused. Assistant answers after your next message.");
    expect($("status").textContent).toBe("Paused");
    expect($("pause").disabled).toBe(true);
    expect($("pause").getAttribute("aria-pressed")).toBe("true");
    expect($("wait").hidden).toBe(true);
    // A pause doesn't bring the typing bubble.
    expect(document.querySelector(".bubble.typing")).toBeNull();

    type("continua");
    enter();
    expect($("paused-line").hidden).toBe(true);
    socket.receive({ type: "resumed" });
    expect($("pause").disabled).toBe(false);
  });

  it("shows no typing bubble when a pause ends the wait, in the order the runtime sends", async () => {
    const { socket } = await opened();
    socket.receive({
      type: "wait",
      deadline: { remainingMs: 9_000, spanMs: 10_000, holding: false },
    });
    socket.receive({ type: "paused" });
    socket.receive({ type: "wait", deadline: null });
    expect(document.querySelector(".bubble.typing, .bubble.stopped")).toBeNull();
  });

  it("keeps the held bar full for as long as the owner keeps typing", async () => {
    const { socket } = await opened();
    const animate = vi.spyOn(Element.prototype, "animate");
    const fill = document.querySelector(".wait-fill");
    const last = () =>
      animate.mock.calls.filter((_call, index) => animate.mock.contexts[index] === fill).at(-1)[0];
    type("e");
    socket.receive({
      type: "wait",
      deadline: { remainingMs: 4_000, spanMs: 4_000, holding: true },
    });
    for (let keystroke = 0; keystroke < 3; keystroke += 1) {
      vi.advanceTimersByTime(600);
      type("e mais");
      expect(last().at(-1)).toEqual({ transform: "scaleX(1)" });
    }
    vi.advanceTimersByTime(1_000);
    expect(last().at(-1)).toEqual({ transform: "scaleX(0)", offset: 1 });
    animate.mockRestore();
  });

  it("stops the turn in place when a pause comes in the middle of it", async () => {
    const { socket } = await opened();
    socket.receive({ type: "typing", active: true });
    expect($("status").textContent).toBe("Typing");
    socket.receive({ type: "paused" });
    expect(document.querySelector(".bubble.stopped").textContent).toContain(
      "Stopped by your pause",
    );
    socket.receive({ type: "typing", active: false });
    socket.receive({ type: "status", status: "unknown-step" });
  });

  it("drops a typing indicator that outlives its bubble, and a turn that stops", async () => {
    const { socket } = await opened();
    socket.receive({ type: "typing", active: true });
    vi.advanceTimersByTime(20_000);
    await vi.waitFor(() => expect(document.querySelector(".bubble.typing")).toBeNull());
    socket.receive({ type: "status", status: "memory" });
    expect($("status").textContent).toBe("Reading memory");
    socket.receive({ type: "status", status: "idle" });
    expect($("status").textContent).toBe("");
  });

  it("confirms from the card, and toasts the receipt when the card is out of sight", async () => {
    const { socket } = await opened();
    socket.receive({ type: "bubble", text: "Change the tier?", confirmation: 4 });
    const confirm = document.querySelector("button.confirm");
    // A press in the card's first 400 ms doesn't count (ADR-0052 §5).
    vi.advanceTimersByTime(400);
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(socket.sentOf("confirm")).toEqual([{ type: "confirm", id: 4, agent: "assistant" }]);
    socket.receive({ type: "confirmation", id: 4, status: "accepted" });
    const toast = document.querySelector(".toast");
    expect(toast.textContent).toContain("You confirmed at 2:32 PM");
    const scrolled = vi.fn();
    document.querySelector(".bubble.card").scrollIntoView = scrolled;
    toast.querySelector("button").click();
    expect(scrolled).toHaveBeenCalledWith({ block: "center" });
    // A frame without a valid id is ignored.
    socket.receive({ type: "confirmation", id: "4", status: "accepted" });
  });

  it("ignores what isn't one of Kelpie's frames", async () => {
    const { socket } = await opened();
    socket.receive("not json");
    socket.receive({ nope: true });
    socket.receive({ type: "something-new" });
    // Nothing closed the conversation's socket, so it opened no other.
    expect(FakeSocket.all.filter((each) => !each.url.includes("view=presence"))).toHaveLength(1);
  });
});

describe("following the chat (5.10)", () => {
  function scrolledAway() {
    const scroller = $("scroller");
    Object.defineProperty(scroller, "scrollHeight", { value: 3_000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    return scroller;
  }

  it("counts replies that arrive below, and an approval waiting wins", async () => {
    const { socket } = await opened();
    scrolledAway();
    socket.receive({ type: "bubble", text: "Um." });
    socket.receive({ type: "bubble", text: "Dois." });
    expect($("pill").hidden).toBe(false);
    expect($("pill").textContent).toBe("↓ 2 new");
    socket.receive({ type: "bubble", text: "Confirm?", confirmation: 2 });
    expect($("pill").textContent).toBe("↓ Approval waiting");
    expect($("pill").hasAttribute("data-approval")).toBe(true);
  });

  it("returns to the end on the pill, on End and on sending", async () => {
    const { socket } = await opened();
    const scroller = scrolledAway();
    socket.receive({ type: "bubble", text: "Novo." });
    $("pill").click();
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => expect($("pill").hidden).toBe(true));

    scrolledAway();
    socket.receive({ type: "bubble", text: "Mais um." });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(scroller.scrollTop).toBeGreaterThan(0);

    scrolledAway();
    type("volto");
    enter();
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("clears the pill when the reader scrolls back to the end", async () => {
    const { socket } = await opened();
    const scroller = scrolledAway();
    socket.receive({ type: "bubble", text: "Novo." });
    scroller.scrollTop = 2_500;
    scroller.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => expect($("pill").hidden).toBe(true));
    // The stuck day labels fade 1 s after scrolling stops.
    vi.advanceTimersByTime(1_000);
  });

  it("pauses the follow while the reader selects text", async () => {
    const { socket } = await opened([{ role: "assistant", text: "Selecione isto.", at: NOW }]);
    const text = document.querySelector(".bubble .text").firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    socket.receive({ type: "bubble", text: "Novo." });
    expect($("pill").textContent).toBe("↓ 1 new");
    document.getSelection().removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
});

describe("the keyboard", () => {
  it("tells screen readers what Enter does, with no hint on the screen (decision 4)", async () => {
    await opened();
    const hint = $($("text").getAttribute("aria-describedby"));
    expect(hint.classList.contains("visually-hidden")).toBe(true);
    expect(hint.textContent).toBe("Enter sends, and Shift+Enter starts a new line.");
  });

  it("sends a printable key to the composer, but not from a button or a field", async () => {
    await opened();
    const key = (target, init) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    key(document.body, { key: "o" });
    expect(document.activeElement).toBe($("text"));
    $("pause").focus();
    key($("pause"), { key: "o" });
    expect(document.activeElement).toBe($("pause"));
    key(document.body, { key: "k", ctrlKey: true });
    key(document.body, { key: "Shift" });
    expect(document.activeElement).toBe($("pause"));
    key($("text"), { key: "End" });
  });
});
