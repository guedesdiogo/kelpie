import { beforeEach, describe, expect, it, vi } from "vitest";

const root = document.documentElement;

/** Runs boot.js afresh with the system's media answers in `media`. */
async function boot({ stored, media = {} } = {}) {
  vi.resetModules();
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem("kelpie.display", stored);
  for (const name of ["data-theme", "data-contrast", "data-reduced"]) root.removeAttribute(name);
  const queries = new Map();
  vi.stubGlobal("matchMedia", (query) => {
    const listeners = [];
    const entry = {
      matches: Boolean(media[query]),
      addEventListener: (_type, listener) => listeners.push(listener),
      fire(matches) {
        entry.matches = matches;
        for (const listener of listeners) listener();
      },
    };
    queries.set(query, entry);
    return entry;
  });
  document.head.innerHTML = '<meta name="theme-color" content="">';
  await import("../../public/webchat/boot.js");
  return { display: globalThis.kelpieDisplay, queries };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the owner's display choices, before the first paint", () => {
  it("follows the system when nothing is stored", async () => {
    const { display } = await boot();
    expect(display.current).toEqual({ theme: "system", motion: "system", contrast: "system" });
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(root.hasAttribute("data-contrast")).toBe(false);
    expect(display.reduced).toBe(false);
  });

  it("takes the system's reduced motion and higher contrast", async () => {
    const { display } = await boot({
      media: { "(prefers-reduced-motion: reduce)": true, "(prefers-contrast: more)": true },
    });
    expect(root.hasAttribute("data-reduced")).toBe(true);
    expect(root.dataset.contrast).toBe("more");
    expect(display.reduced).toBe(true);
    expect(display.systemReduced).toBe(true);
  });

  it("applies and keeps the owner's choices, and ignores what isn't one", async () => {
    const { display } = await boot({
      stored: '{"theme":"dark","motion":"less","contrast":"bogus"}',
    });
    expect(root.dataset.theme).toBe("dark");
    expect(root.hasAttribute("data-reduced")).toBe(true);
    expect(root.hasAttribute("data-contrast")).toBe(false);
    expect(display.systemReduced).toBe(false);

    const changed = vi.fn();
    display.onChange(changed);
    display.set({ theme: "system", contrast: "more", motion: "nonsense" });
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(root.dataset.contrast).toBe("more");
    expect(root.hasAttribute("data-reduced")).toBe(false);
    expect(JSON.parse(localStorage.getItem("kelpie.display"))).toEqual({
      theme: "system",
      motion: "system",
      contrast: "more",
    });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("follows a change of the system's setting while the page is open", async () => {
    const { queries } = await boot();
    queries.get("(prefers-reduced-motion: reduce)").fire(true);
    expect(root.hasAttribute("data-reduced")).toBe(true);
  });

  it("survives storage that throws or holds garbage", async () => {
    const { display } = await boot({ stored: "{not json" });
    expect(display.current.theme).toBe("system");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    display.set({ theme: "light" });
    expect(root.dataset.theme).toBe("light");
    expect(display.current.theme).toBe("light");
    setItem.mockRestore();
  });
});
