import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESS_GUARD_MS, RING_MS } from "../../public/webchat/card.js";
import { CONFIRMATION_MS } from "../../public/webchat/mascot-states.js";
import { TEXTS } from "../../public/webchat/texts.js";
import { Thread } from "../../public/webchat/thread.js";

const T = TEXTS.en;
/** Thursday 15 October 2026, 14:32 in the browser's zone. */
const NOW = new Date(2026, 9, 15, 14, 32).getTime();

let root;
let changes;
let announced;
let confirms;
let pauses;
let thread;

function make({ allow = true } = {}) {
  root = document.createElement("div");
  document.body.replaceChildren(root);
  changes = [];
  announced = [];
  confirms = [];
  pauses = 0;
  thread = new Thread(root, {
    texts: T,
    locale: "en",
    agentName: () => "Agenda",
    less: () => false,
    onConfirm: (id) => {
      confirms.push(id);
      return allow;
    },
    onPause: () => {
      pauses += 1;
      return allow;
    },
    onAnnounce: (text) => announced.push(text),
    onChange: (change) => changes.push(change),
  });
}

/** The receipt shows once the card's content has left (5.3). */
async function receiptOf(card) {
  vi.advanceTimersByTime(200);
  await vi.waitFor(() => expect(card.querySelector(".receipt")).not.toBeNull());
  return card.querySelector(".receipt");
}

const bubbles = () => [...root.querySelectorAll(".bubble")];
const markOf = (id) => root.querySelector(`[data-id="${id}"]`).parentElement.querySelector(".mark");
/** A mark that goes fades out first (5.1). */
async function cleared(id) {
  vi.advanceTimersByTime(200);
  await vi.waitFor(() => expect(markOf(id).dataset.mark).toBe(""));
  expect(markOf(id).textContent).toBe("");
}

beforeEach(() => {
  vi.useFakeTimers({
    now: NOW,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  document.documentElement.removeAttribute("data-reduced");
  make();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the replayed history", () => {
  it("groups one sender's messages by day and by 10 minutes, quietly", () => {
    const yesterday = NOW - 86_400_000;
    thread.replay([
      { role: "user", text: "ontem", at: yesterday },
      { role: "user", text: "oi", at: NOW - 20 * 60_000 },
      { role: "user", text: "tudo bem?", at: NOW - 19 * 60_000 },
      { role: "assistant", text: "Tudo.", at: NOW - 18 * 60_000 },
      { role: "assistant", text: "E você?", at: NOW - 2 * 60_000 },
    ]);

    const days = [...root.querySelectorAll(".day")];
    expect(days.map((day) => day.querySelector(".day-label").textContent)).toEqual([
      "Yesterday",
      "Today",
    ]);
    expect(days[1].querySelector("time").dateTime).toBe("2026-10-15");
    const groups = [...days[1].querySelectorAll(".group")];
    expect(groups.map((group) => group.querySelectorAll(".message").length)).toEqual([2, 1, 1]);
    expect(groups[0].querySelector("h3").textContent).toBe("You, 2:12 PM");
    expect(groups[1].querySelector("h3").textContent).toBe("Agenda, 2:14 PM");
    // A group has no time under it: each bubble's shows on hover or a tap (decision 1, #378).
    expect(root.querySelector(".group-time")).toBeNull();
    expect(bubbles()[1].querySelector("time.at").textContent).toBe("2:12 PM");
    expect(announced).toEqual([]);
    expect(changes).toEqual([]);
    expect(thread.isEmpty).toBe(false);
  });

  it("holds the owner's latest messages from the history while a wait is on", () => {
    thread.replay([
      { role: "user", text: "antes", at: NOW - 3 * 60_000 },
      { role: "assistant", text: "Resposta.", at: NOW - 2 * 60_000 },
      { role: "user", text: "depois", at: NOW - 60_000 },
    ]);
    const marks = () => [...root.querySelectorAll(".mark")].map((mark) => mark.textContent);
    expect(marks()).toEqual(["", ""]);
    thread.setWaiting(true);
    expect(marks()).toEqual(["", "Held"]);
  });

  it("starts over on every replay", () => {
    thread.replay([{ role: "user", text: "um", at: NOW }]);
    thread.replay([{ role: "assistant", text: "dois", at: NOW }]);
    expect(bubbles().map((bubble) => bubble.querySelector(".text").textContent)).toEqual(["dois"]);
    thread.replay([]);
    expect(thread.isEmpty).toBe(true);
  });
});

describe("a new message below (5.1)", () => {
  it("slides the bubbles above up from where they were, with --spring-base", () => {
    thread.replay([{ role: "assistant", text: "Oi.", at: NOW - 60_000 }]);
    const old = root.querySelector(".message");
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {} }));
    old.animate = animate;
    // Before the new bubble arrives, the old one sits 40 px lower than after.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => {
      const top = root.querySelectorAll(".message").length > 1 ? 60 : 100;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top };
    });
    thread.owner({ id: "m1", text: "nova" });
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translateY(40px)" }, { transform: "none" }],
      expect.objectContaining({ easing: expect.stringContaining("linear(") }),
    );
    vi.restoreAllMocks();
  });
});

describe("the owner's messages", () => {
  it("show nothing at first, 'Sending' after 300 ms, and 'Held' while the wait holds them", async () => {
    thread.owner({ id: "m1", text: "então" });
    expect(changes.at(-1).kind).toBe("owner");
    expect(markOf("m1").dataset.mark).toBe("");
    vi.advanceTimersByTime(300);
    expect(markOf("m1").textContent).toBe("Sending");

    thread.accept("m1");
    await cleared("m1");
    thread.setWaiting(true);
    expect(markOf("m1").textContent).toBe("Held");
    expect(markOf("m1").querySelector("svg.icon-clock")).not.toBeNull();
    thread.setWaiting(false);
    await cleared("m1");
  });

  it("stop being held once a reply comes", async () => {
    thread.owner({ id: "m1", text: "então" });
    thread.accept("m1");
    thread.setWaiting(true);
    thread.reply({ text: "Sim." });
    thread.setWaiting(false);
    thread.setWaiting(true);
    await cleared("m1");
  });

  it("wait in --sunken while queued, and say why one was refused", () => {
    thread.owner({ id: "m1", text: "offline", queued: true });
    expect(markOf("m1").textContent).toBe("Queued");
    expect(markOf("m1").parentElement.hasAttribute("data-queued")).toBe(true);
    thread.accept("m1");
    expect(markOf("m1").parentElement.hasAttribute("data-queued")).toBe(false);

    thread.owner({ id: "m2", text: "x".repeat(10) });
    thread.refuse("m2", "too_long");
    expect(markOf("m2").textContent).toBe("Not sent: too long");
    expect(markOf("m2").querySelector("svg.icon-alert")).not.toBeNull();
    thread.refuse("m2", "other");
    thread.owner({ id: "m3", text: "?" });
    thread.refuse("m3", "agent_mismatch");
    expect(markOf("m3").textContent).toBe("Not sent");
    // A late frame for an unknown or settled message changes nothing.
    thread.accept("nope");
    thread.accept("m2");
    expect(markOf("m2").textContent).toBe("Not sent: too long");
  });
});

describe("a turn's activity (5.1, 5.2)", () => {
  it("shows the typing bubble, its phase and, from 3 s, the elapsed time", () => {
    thread.working(null);
    const typing = root.querySelector(".bubble.typing");
    expect(typing.getAttribute("aria-hidden")).toBe("true");
    expect(typing.querySelectorAll(".dots span")).toHaveLength(3);
    thread.working("memory");
    expect(typing.querySelector(".phase").textContent).toBe("Reading memory");
    vi.advanceTimersByTime(3_000);
    expect(typing.querySelector(".phase").textContent).toBe("Reading memory · 3 s");
    expect(changes.map((change) => change.kind)).toEqual(["typing"]);
  });

  it("gives tool calls a row whose label rolls, then sums it up when the reply takes its place", () => {
    thread.working(null);
    const typing = root.querySelector(".bubble.typing");
    thread.tool("Searching memory");
    const row = root.querySelector(".tool-row");
    expect(row.dataset.state).toBe("running");
    expect(row.querySelector(".tool-head").disabled).toBe(true);
    expect(row.querySelector(".tool-label").textContent).toBe("Searching memory");
    expect(row.querySelector(".tool-icon").dataset.state).toBe("waiting");
    vi.advanceTimersByTime(200);
    expect(row.querySelector(".tool-icon").dataset.state).toBe("spinning");
    vi.advanceTimersByTime(3_000);
    expect(row.querySelector(".tool-elapsed").textContent).toBe("3 s");

    thread.working("thinking");
    expect(row.querySelector(".tool-elapsed").textContent).toBe("");
    vi.advanceTimersByTime(500);
    thread.tool("Reading people/ana.md");
    expect(row.querySelector(".tool-label .roll:last-child").textContent).toBe(
      "Reading people/ana.md",
    );
    vi.advanceTimersByTime(1_000);

    const reply = thread.reply({ text: "Pronto." });
    // The same element carries the states (rule 6), and screen readers reach it once a reply.
    expect(reply).toBe(typing);
    expect(reply.classList.contains("typing")).toBe(false);
    expect(reply.hasAttribute("aria-hidden")).toBe(false);
    expect(reply.querySelector(".text").textContent).toBe("Pronto.");
    expect(reply.querySelector("time.at")).not.toBeNull();
    expect(row.dataset.state).toBe("done");
    expect(row.querySelector(".tool-label .roll:last-child").textContent).toBe("2 steps · 4.7 s");
    expect(row.querySelector(".tool-icon svg.icon-check")).not.toBeNull();

    const head = row.querySelector(".tool-head");
    expect(head.disabled).toBe(false);
    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const steps = [...row.querySelectorAll(".tool-steps li")];
    expect(steps.map((step) => step.firstChild.textContent)).toEqual([
      "Searching memory",
      "Reading people/ana.md",
    ]);
    expect(steps[0].querySelector(".step-time").textContent).toBe("3.2 s");
    head.click();
    expect(row.querySelector(".tool-steps").hidden).toBe(true);
    expect(changes.at(-1).kind).toBe("reply");
  });

  it("removes the typing bubble when the turn stops without a reply", async () => {
    thread.working(null);
    thread.stop("idle");
    await vi.waitFor(() => expect(root.querySelector(".bubble.typing")).toBeNull());
    expect(root.querySelector(".group")).toBeNull();
    expect(thread.isEmpty).toBe(true);
    // Nothing to stop.
    thread.stop("idle");
  });

  it("says in place that the owner's pause stopped the turn", () => {
    thread.working(null);
    thread.tool("Searching the web");
    thread.stop("paused");
    const stopped = root.querySelector(".bubble.stopped");
    expect(stopped.textContent).toContain("Stopped by your pause");
    expect(stopped.hasAttribute("aria-hidden")).toBe(false);
    const row = root.querySelector(".tool-row");
    expect(row.querySelector(".tool-label .roll:last-child").textContent).toBe(
      "Stopped by your pause",
    );
    expect(row.querySelector(".tool-icon svg.icon-neutral")).not.toBeNull();
  });

  it("ends the activity when the owner sends a message, which interrupts the turn", async () => {
    thread.working(null);
    thread.owner({ id: "m1", text: "espera" });
    await vi.waitFor(() => expect(root.querySelector(".bubble.typing")).toBeNull());
    expect(bubbles().at(-1).textContent).toContain("espera");
  });

  it("shows a failure's notice with its icon", () => {
    const bubble = thread.reply({ text: "No model answered.", failed: true });
    expect(bubble.classList.contains("failed")).toBe(true);
    expect(bubble.querySelector("svg.icon-alert")).not.toBeNull();
  });
});

describe("the confirmation card (5.3)", () => {
  const notice = { text: "Kelpie wants to change the tier.", confirmation: 7 };

  it("says who asks and until when, above the notice and its actions", () => {
    const card = thread.reply(notice);
    expect(card.querySelector(".card-who").textContent).toBe("Agenda asks you to confirm");
    expect(card.querySelector(".card-until").textContent).toBe("Valid until 2:42 PM");
    expect(card.querySelector(".text").textContent).toBe("Kelpie wants to change the tier.");
    expect(card.querySelector(".card-actions button.confirm")).not.toBeNull();
  });

  it("confirms on a press, then folds into a receipt that says who decided when", async () => {
    const card = thread.reply(notice);
    expect(changes.at(-1).kind).toBe("approval");
    expect(thread.openCards.map((open) => open.id)).toEqual([7]);
    const confirm = card.querySelector("button.confirm");
    expect(confirm.textContent).toBe("Confirm");

    vi.advanceTimersByTime(PRESS_GUARD_MS);
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(confirms).toEqual([7]);
    expect(card.dataset.state).toBe("working");
    expect(confirm.disabled).toBe(true);
    expect(confirm.querySelector(".label .roll:last-child").textContent).toBe("Confirming");
    vi.advanceTimersByTime(200);
    expect(confirm.querySelector(".confirm-icon").dataset.state).toBe("spinning");
    // The old label rolls away: only the new one stays.
    await vi.waitFor(() => expect(confirm.querySelector(".label").textContent).toBe("Confirming"));
    // A second press while it works does nothing.
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(confirms).toEqual([7]);

    thread.confirmation(7, "accepted");
    expect(card.dataset.state).toBe("done");
    expect(card.querySelector(".confirm-icon svg.icon-check")).not.toBeNull();
    expect(thread.openCards).toEqual([]);
    vi.advanceTimersByTime(RING_MS);
    // Its content leaves first, then the card folds to the receipt's height (5.3).
    expect((await receiptOf(card)).textContent).toBe("You confirmed at 2:32 PM");
    expect(card.querySelector(".card-actions")).toBeNull();
    expect(card.querySelector(".card-who")).toBeNull();
    expect(announced).toEqual(["You confirmed at 2:32 PM"]);
    expect(changes.at(-1)).toMatchObject({ kind: "receipt" });
  });

  it("folds into a neutral receipt when the press is refused", async () => {
    const card = thread.reply(notice);
    card.querySelector("button.confirm").click();
    thread.confirmation(7, "refused");
    expect((await receiptOf(card)).textContent).toBe("No longer valid. Ask again.");
    expect(card.querySelector(".receipt svg.icon-neutral")).not.toBeNull();
  });

  it("expires after its 10 minutes, or at once when it arrives already expired", async () => {
    const card = thread.reply(notice);
    vi.advanceTimersByTime(CONFIRMATION_MS);
    expect((await receiptOf(card)).textContent).toBe("Expired. Ask again if you still want it.");

    make();
    thread.replay([
      { role: "assistant", text: "Old notice", at: NOW - CONFIRMATION_MS - 1, confirmation: 9 },
    ]);
    expect(root.querySelector(".receipt").textContent).toBe(
      "Expired. Ask again if you still want it.",
    );
    expect(announced).toEqual([]);
  });

  it("acts from the keyboard only on a key pressed on its button, never one held down before", () => {
    const card = thread.reply(notice);
    const confirm = card.querySelector("button.confirm");
    vi.advanceTimersByTime(PRESS_GUARD_MS);
    confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true }));
    confirm.dispatchEvent(new MouseEvent("click", { detail: 0 }));
    expect(confirms).toEqual([]);
    confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    confirm.dispatchEvent(new MouseEvent("click", { detail: 0 }));
    expect(confirms).toEqual([7]);
    // A keyboard confirm skips the grow, the pop and the ring.
    thread.confirmation(7, "accepted");
    expect(card.querySelector(".ring")).toBeNull();
  });

  it("ignores a press in its first 400 ms, since it may have appeared under the pointer", () => {
    const card = thread.reply(notice);
    const confirm = card.querySelector("button.confirm");
    vi.advanceTimersByTime(PRESS_GUARD_MS - 1);
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(confirms).toEqual([]);
    expect(card.dataset.state).toBeUndefined();
    vi.advanceTimersByTime(1);
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(confirms).toEqual([7]);
  });

  it("does nothing while the socket can't take the press", () => {
    make({ allow: false });
    const card = thread.reply(notice);
    card.querySelector("button.confirm").click();
    expect(card.dataset.state).toBeUndefined();
    expect(thread.openCards).toHaveLength(1);
  });

  it("answers every notice of the same confirmation", async () => {
    const first = thread.reply(notice);
    const second = thread.reply(notice);
    thread.confirmation(7, "accepted");
    vi.advanceTimersByTime(RING_MS);
    await receiptOf(first);
    await receiptOf(second);
    // A late answer for a card already folded changes nothing.
    thread.confirmation(7, "refused");
    expect(first.querySelector(".receipt").textContent).toBe("You confirmed at 2:32 PM");
  });

  it("leaves room in its action row for Deny (#361)", () => {
    const card = thread.reply(notice);
    const actions = card.querySelector(".card-actions");
    const deny = document.createElement("button");
    deny.textContent = "Deny this call";
    actions.prepend(deny);
    expect([...actions.children].map((button) => button.textContent)).toEqual([
      "Deny this call",
      "Confirm",
    ]);
  });

  it("pauses the conversation from the hold under its actions, only once held long enough (ADR-0044 §2)", () => {
    const card = thread.reply(notice);
    const hold = card.querySelector("button.hold");
    expect(hold.textContent).toBe("Hold to pause this conversation");
    hold.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    vi.advanceTimersByTime(600);
    hold.dispatchEvent(new PointerEvent("pointerup"));
    vi.advanceTimersByTime(2_000);
    // Let go too soon: nothing.
    expect(pauses).toBe(0);
    hold.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    vi.advanceTimersByTime(1_200);
    expect(pauses).toBe(1);
    // From the keyboard, a held Space does the same.
    make();
    const again = thread.reply(notice).querySelector("button.hold");
    again.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    vi.advanceTimersByTime(1_200);
    expect(pauses).toBe(1);
  });
});
