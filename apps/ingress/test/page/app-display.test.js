import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, historyFrame, loadPage, settle } from "./harness.js";

const root = document.documentElement;
const radios = (id) => [...$(id).querySelectorAll("[role='radio']")];
const checked = (id) =>
  radios(id).find((radio) => radio.getAttribute("aria-checked") === "true")?.dataset.value;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Display menu (§5.22)", () => {
  it("sets the theme, less motion and more contrast, in this browser", async () => {
    await loadPage();
    $("display-button").click();
    expect($("display").hidden).toBe(false);
    expect(checked("theme")).toBe("system");
    expect(checked("motion-setting")).toBe("system");
    expect(checked("contrast")).toBe("system");

    radios("theme")
      .find((radio) => radio.dataset.value === "dark")
      .click();
    expect(root.dataset.theme).toBe("dark");
    radios("motion-setting")
      .find((radio) => radio.dataset.value === "less")
      .click();
    expect(root.hasAttribute("data-reduced")).toBe(true);
    radios("contrast")
      .find((radio) => radio.dataset.value === "more")
      .click();
    expect(root.dataset.contrast).toBe("more");
    expect(JSON.parse(localStorage.getItem("kelpie.display"))).toEqual({
      theme: "dark",
      motion: "less",
      contrast: "more",
    });
  });

  it("can't turn off the system's reduced motion", async () => {
    const reduced = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener() {},
    }));
    await loadPage();
    $("display-button").click();
    expect(checked("motion-setting")).toBe("less");
    expect(radios("motion-setting").every((radio) => radio.disabled)).toBe(true);
    reduced.mockRestore();
  });
});

describe("the mascot in the header (ADR-0045)", () => {
  const KELPIE = {
    shape: "mark",
    color: "kelp",
    eyes: "shine",
    cheeks: false,
    head: { type: "ears", variation: "pointed" },
    accessory: { type: "belt", variation: "collar" },
  };

  it("asks how it moves before it first moves, and keeps the answer in the Display menu", async () => {
    const { socket } = await loadPage();
    socket.open();
    socket.receive(historyFrame());
    socket.receive({ type: "agent", mascot: KELPIE });
    await settle();
    expect($("mascot").childElementCount).toBeGreaterThan(0);
    expect($("motion-ask").hidden).toBe(false);
    // Until the owner answers, the menu has nothing to keep.
    expect($("mascot-setting").hidden).toBe(true);

    $("motion-ask").querySelector('[data-motion="states"]').click();
    expect(localStorage.getItem("kelpie.mascotMotion")).toBe("states");
    expect($("motion-ask").hidden).toBe(true);
    expect($("mascot-setting").hidden).toBe(false);
    $("display-button").click();
    expect(checked("motion")).toBe("states");
    radios("motion")
      .find((radio) => radio.dataset.value === "still")
      .click();
    expect(localStorage.getItem("kelpie.mascotMotion")).toBe("still");

    // Less motion means Still, and the setting says why it can't move.
    radios("motion-setting")
      .find((radio) => radio.dataset.value === "less")
      .click();
    expect(radios("motion").every((radio) => radio.disabled)).toBe(true);
    expect($("motion-note").textContent).toBe("Still, because reduced motion is on");

    // A wait with its bar makes it listen; a new look changes it in place.
    socket.receive({
      type: "wait",
      deadline: { remainingMs: 5_000, spanMs: 5_000, holding: false },
    });
    socket.receive({ type: "agent", mascot: { ...KELPIE, color: "lagoon" } });
    socket.receive({ type: "agent", mascot: { shape: "nope" } });
    $("mascot").click();
  });

  it("shows at 160 px in the empty conversation", async () => {
    const { socket } = await loadPage();
    socket.open();
    socket.receive(historyFrame());
    vi.advanceTimersByTime(500);
    await settle();
    expect($("empty").hidden).toBe(false);
    socket.receive({ type: "agent", mascot: KELPIE });
    await settle();
    expect($("empty-mascot").childElementCount).toBeGreaterThan(0);
  });
});

describe("leftovers", () => {
  it("lets go of the empty conversation's mascot once a message arrives", async () => {
    const { socket } = await loadPage();
    socket.open();
    socket.receive(historyFrame());
    vi.advanceTimersByTime(500);
    await settle();
    socket.receive({
      type: "agent",
      mascot: {
        shape: "mark",
        color: "kelp",
        eyes: "shine",
        cheeks: false,
        head: { type: "ears", variation: "pointed" },
        accessory: { type: "belt", variation: "collar" },
      },
    });
    await settle();
    const host = $("empty-mascot");
    expect(host.childElementCount).toBeGreaterThan(0);
    socket.receive({ type: "bubble", text: "Olá." });
    // The host leaves the page, so the mascots' shared timer stops ticking for it.
    expect(host.isConnected).toBe(false);
    expect($("empty-mascot").childElementCount).toBe(0);
  });

  it("leaves End to the menus that handle it", async () => {
    await loadPage();
    const scroller = $("scroller");
    Object.defineProperty(scroller, "scrollHeight", { value: 3_000, configurable: true });
    scroller.scrollTop = 0;
    $("switcher").click();
    $("agents")
      .querySelector("a")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(scroller.scrollTop).toBe(0);
  });
});
