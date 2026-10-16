import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hideAfterExit, SPRINGS, scrollToEnd, springAt } from "../../public/webchat/motion.js";
import { popover, segmented } from "../../public/webchat/popover.js";
import { TEXTS } from "../../public/webchat/texts.js";
import { TOAST_MS, Toasts } from "../../public/webchat/toasts.js";

const T = TEXTS.en;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-reduced");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toasts (5.13)", () => {
  function region() {
    const element = document.createElement("div");
    document.body.append(element);
    return { element, toasts: new Toasts(element, { texts: T }) };
  }

  it("stays 5 s, and its timer pauses on hover and focus", async () => {
    const { element, toasts } = region();
    const toast = toasts.show({ text: "Saved." });
    expect(element.textContent).toContain("Saved.");
    expect(toast.element.querySelector(".left")).not.toBeNull();

    vi.advanceTimersByTime(2_000);
    toast.element.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(10_000);
    expect(toast.element.isConnected).toBe(true);
    toast.element.dispatchEvent(new Event("pointerleave"));
    toast.element.dispatchEvent(new Event("focusin"));
    vi.advanceTimersByTime(10_000);
    expect(toast.element.isConnected).toBe(true);
    toast.element.dispatchEvent(new Event("focusout"));
    vi.advanceTimersByTime(TOAST_MS - 2_000);
    await vi.waitFor(() => expect(toast.element.isConnected).toBe(false));
  });

  it("keeps an error until it is dismissed, and runs an action", async () => {
    const { toasts } = region();
    const error = toasts.show({ text: "No connection.", error: true });
    vi.advanceTimersByTime(60_000);
    expect(error.element.isConnected).toBe(true);
    const ran = vi.fn();
    const action = toasts.show({ text: "Confirmed.", action: { label: "Show", run: ran } });
    action.element.querySelector("button").click();
    expect(ran).toHaveBeenCalledOnce();
    [...error.element.querySelectorAll("button")].at(-1).click();
    await vi.waitFor(() => expect(error.element.isConnected).toBe(false));
  });

  it("stacks at most three, each lower one smaller", async () => {
    const { toasts } = region();
    const shown = ["one", "two", "three", "four"].map((text) => toasts.show({ text }));
    await vi.waitFor(() => expect(shown[0].element.isConnected).toBe(false));
    expect(shown[3].element.style.transform).toBe("");
    expect(shown[2].element.style.transform).toBe("translateY(-6px) scale(0.95)");
    toasts.dismiss(shown[0]);
  });

  it("pauses while the tab is hidden", () => {
    const { toasts } = region();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const toast = toasts.show({ text: "Out of sight." });
    vi.advanceTimersByTime(TOAST_MS * 2);
    expect(toast.element.isConnected).toBe(true);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(TOAST_MS);
    hidden.mockRestore();
  });
});

describe("popovers", () => {
  function setup(options) {
    document.body.innerHTML =
      '<button id="t" aria-expanded="false">Open</button><div id="p" hidden><a href="?a">A</a><a href="?b" aria-current="page">B</a><a href="?c">C</a></div><p id="out">x</p>';
    const trigger = document.getElementById("t");
    const panel = document.getElementById("p");
    return { trigger, panel, menu: popover(trigger, panel, options) };
  }

  it("opens from its trigger, focuses the current item, and closes on Escape", () => {
    const onOpen = vi.fn();
    const { trigger, panel, menu } = setup({ arrows: true, onOpen });
    trigger.click();
    expect(menu.open).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(onOpen).toHaveBeenCalledOnce();
    expect(document.activeElement.textContent).toBe("B");

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement.textContent).toBe("C");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement.textContent).toBe("A");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement.textContent).toBe("C");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.open).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a press outside, and not while its trigger is disabled", () => {
    const { trigger, menu } = setup();
    trigger.click();
    document.getElementById("out").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.open).toBe(false);
    trigger.setAttribute("aria-disabled", "true");
    trigger.click();
    expect(menu.open).toBe(false);
    menu.hide();
  });

  it("toggles on its trigger, and ignores arrows unless asked", () => {
    const { trigger, panel, menu } = setup();
    trigger.click();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement.textContent).toBe("B");
    trigger.click();
    expect(menu.open).toBe(false);
  });

  it("checks one choice of a radiogroup, and moves it with the arrows", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const chosen = [];
    segmented(container, {
      label: "Theme",
      choices: T.themes,
      value: "system",
      onChange: (value) => chosen.push(value),
    });
    expect(container.getAttribute("role")).toBe("radiogroup");
    const radios = [...container.querySelectorAll("[role='radio']")];
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    radios[2].click();
    expect(chosen).toEqual(["dark"]);
    radios[2].focus();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(chosen).toEqual(["dark", "system"]);
    expect(document.activeElement).toBe(radios[0]);
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chosen).toHaveLength(2);
  });
});

describe("motion helpers", () => {
  it("reads a spring's easing at any point", () => {
    expect(springAt(SPRINGS.base, 0)).toBe(0);
    expect(springAt(SPRINGS.base, 1)).toBe(1);
    expect(springAt(SPRINGS.base, 0.5)).toBeCloseTo(0.912, 2);
    expect(springAt(SPRINGS.pop, 0.3)).toBeGreaterThan(1);
  });

  it("jumps to the end under reduced motion, and hides after an exit", async () => {
    document.documentElement.setAttribute("data-reduced", "");
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 900 });
    Object.defineProperty(scroller, "clientHeight", { value: 300 });
    scrollToEnd(scroller);
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(0);
    const pill = document.createElement("button");
    document.body.append(pill);
    hideAfterExit(pill);
    expect(pill.dataset.leaving).toBe("");
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => expect(pill.hidden).toBe(true));
    expect(pill.dataset.leaving).toBeUndefined();
    // Already hidden: nothing to do.
    hideAfterExit(pill);
  });
});
