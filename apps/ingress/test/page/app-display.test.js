import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, fakeFetch, historyFrame, loadPage, settle } from "./harness.js";

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
  it("opens from the account, with the theme as icons and switches for motion and contrast", async () => {
    await loadPage();
    $("account").click();
    expect($("display").hidden).toBe(false);
    expect($("display").dataset.from).toBe("account");
    expect($("account").getAttribute("aria-expanded")).toBe("true");
    expect(checked("theme")).toBe("system");
    // Each theme is an icon that names itself for screen readers and in a tooltip.
    expect(radios("theme").map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(radios("theme").every((radio) => radio.querySelector("svg.icon"))).toBe(true);
    expect(radios("theme")[2].querySelector(".tip").textContent).toBe("Dark");
    expect($("less-motion").checked).toBe(false);
    expect($("more-contrast").checked).toBe(false);

    radios("theme")
      .find((radio) => radio.dataset.value === "dark")
      .click();
    expect(root.dataset.theme).toBe("dark");
    $("less-motion").click();
    expect(root.hasAttribute("data-reduced")).toBe(true);
    $("more-contrast").click();
    expect(root.dataset.contrast).toBe("more");
    expect(JSON.parse(localStorage.getItem("kelpie.display"))).toEqual({
      theme: "dark",
      motion: "less",
      contrast: "more",
    });
  });

  it("opens from the header's avatar too, and Escape returns there", async () => {
    await loadPage();
    $("account-top").click();
    expect($("display").dataset.from).toBe("account-top");
    $("display").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe($("account-top"));
  });

  it("can't turn off the system's reduced motion", async () => {
    const reduced = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener() {},
    }));
    await loadPage();
    $("account").click();
    expect($("less-motion").checked).toBe(true);
    expect($("less-motion").disabled).toBe(true);
    reduced.mockRestore();
  });

  it("shows the version, and copies it on a press", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await loadPage();
    const version = $("version");
    expect(version.hidden).toBe(false);
    expect(version.textContent).toBe("Kelpie 1.2.3 · abc1234");
    version.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("Kelpie 1.2.3 · abc1234");
    expect(version.querySelector(".roll:last-child").textContent).toBe("Copied");
  });
});

describe("the account (the owner, 2026-10-16)", () => {
  const identity = (body, status = 200) => {
    const base = fakeFetch();
    return vi.fn(async (url, init) =>
      url === "/cdn-cgi/access/get-identity" ? Response.json(body, { status }) : base(url, init),
    );
  };

  it("shows the owner's name and initials, and the email in the menu", async () => {
    await loadPage({ fetch: identity({ name: "Diogo Guedes", email: "diogo@exemplo.com" }) });
    await settle();
    expect(document.querySelector(".account-name").textContent).toBe("Diogo Guedes");
    expect([...document.querySelectorAll(".avatar")].map((avatar) => avatar.textContent)).toEqual([
      "DG",
      "DG",
      "DG",
    ]);
    expect($("account").getAttribute("aria-label")).toBe("Diogo Guedes: account and display");
    expect($("me-name").textContent).toBe("Diogo Guedes");
    expect($("me-email").textContent).toBe("diogo@exemplo.com");
  });

  it("takes the email's initials without a name, and reads Display without a login", async () => {
    await loadPage({ fetch: identity({ email: "ana.souza@exemplo.com" }) });
    await settle();
    expect(document.querySelector(".account-name").textContent).toBe("ana.souza@exemplo.com");
    expect(document.querySelector(".avatar").textContent).toBe("AS");
    expect($("me-email").textContent).toBe("");

    await loadPage();
    await settle();
    expect(document.querySelector(".account-name").textContent).toBe("Display");
    expect(document.querySelector(".avatar svg.icon-display")).not.toBeNull();
  });
});

/** The main agent's default mascot (ADR-0049), as the socket names it. */
const KELPIE = {
  shape: "mark",
  color: "kelp",
  eyes: "big",
  cheeks: false,
  head: { type: "ears", variation: "round" },
  accessory: { type: "none" },
};

describe("the mascot in the header (ADR-0045)", () => {
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
    $("account").click();
    expect(checked("motion")).toBe("states");
    // The mascot's motion is its own outline, each named.
    expect(radios("motion").map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Alive",
      "States only",
      "Still",
    ]);
    expect(radios("motion")[1].querySelector("svg.icon-states")).not.toBeNull();
    radios("motion")
      .find((radio) => radio.dataset.value === "still")
      .click();
    expect(localStorage.getItem("kelpie.mascotMotion")).toBe("still");

    // Less motion means Still, and the setting says why it can't move.
    $("less-motion").click();
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
      mascot: KELPIE,
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
