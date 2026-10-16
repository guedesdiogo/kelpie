import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_TIP_MS, PEER_TIP_MS, tips } from "../../public/webchat/tips.js";

// Icon buttons say their name in a tooltip (#378's research): the first waits, its neighbours
// show at once, the keyboard's focus shows one at once, Escape hides it, and nothing uses `title`.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  document.body.innerHTML = `
    <div id="bar">
      <button type="button" id="a" aria-label="Pause" data-tip></button>
      <button type="button" id="b" aria-label="Send" data-tip></button>
    </div>`;
  tips(document.getElementById("bar"));
});

afterEach(() => {
  vi.useRealTimers();
});

const tipOf = (id) => document.querySelector(`#${id} > .tip`);
const shown = (id) => tipOf(id).dataset.shown !== undefined;

describe("tooltips", () => {
  it("names each button with its label, for the eye only", () => {
    expect(tipOf("a").textContent).toBe("Pause");
    expect(tipOf("a").getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("waits before the first, and shows a neighbour at once", () => {
    document.getElementById("a").dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(FIRST_TIP_MS - 1);
    expect(shown("a")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shown("a")).toBe(true);
    document.getElementById("a").dispatchEvent(new Event("pointerleave"));
    expect(shown("a")).toBe(false);
    document.getElementById("b").dispatchEvent(new Event("pointerenter"));
    expect(shown("b")).toBe(true);
    document.getElementById("b").dispatchEvent(new Event("pointerleave"));
    // Past the window, the next one waits again.
    vi.advanceTimersByTime(PEER_TIP_MS + 1);
    document.getElementById("a").dispatchEvent(new Event("pointerenter"));
    expect(shown("a")).toBe(false);
  });

  it("shows at once for the keyboard's focus, and Escape hides it without moving focus", () => {
    const a = document.getElementById("a");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    a.focus();
    expect(shown("a")).toBe(true);
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(shown("a")).toBe(false);
    expect(document.activeElement).toBe(a);
  });

  it("shows nothing for a click's focus", () => {
    const a = document.getElementById("a");
    document.dispatchEvent(new Event("pointerdown"));
    a.focus();
    expect(shown("a")).toBe(false);
  });

  it("follows a label that changes", () => {
    const a = document.getElementById("a");
    a.setAttribute("aria-label", "Resume");
    tips(document.getElementById("bar"));
    expect(tipOf("a").textContent).toBe("Resume");
  });
});
