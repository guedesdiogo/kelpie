import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVED_MS } from "../../public/webchat/mascot-states.js";
import { $, historyFrame, loadPage, settle } from "./harness.js";

// The agent's editor in the page (#379): its pencil on each mascot, and a save that reaches the
// header, the sidebar and the switcher.

const KELPIE = {
  shape: "mark",
  color: "kelp",
  eyes: "big",
  cheeks: false,
  head: { type: "ears", variation: "round" },
  accessory: { type: "none" },
};
const AGENTS = [
  {
    id: "assistant",
    name: "Assistant",
    master: true,
    mascot: KELPIE,
    specialty: "",
    remit: "Your day.",
  },
  {
    id: "agenda",
    name: "Agenda",
    master: false,
    mascot: { ...KELPIE, color: "fawn" },
    specialty: "Agenda e e-mail",
    remit: "Meetings.",
  },
];

/** The page's fetch: the list, the version, and the editor's saves, which it keeps. */
function editorFetch(puts, listed = AGENTS) {
  return vi.fn(async (url, init = {}) => {
    if (url === "/webchat/agents") return Response.json({ agents: listed });
    if (url === "/version") return Response.json({ version: "1.2.3", commit: "abc1234" });
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      puts.push({ url, headers: init.headers, body });
      return Response.json(url.endsWith("/mascot") ? { mascot: body } : body);
    }
    return new Response(null, { status: 404 });
  });
}

const narrowScreen = () =>
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    // Below the sidebar's width, and a phone for the 600 px query.
    matches: query.includes("max-width"),
    media: query,
    addEventListener() {},
  }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => vi.useRealTimers());

describe("the agent's editor in the page", () => {
  it("opens from the pencil on a row's mascot, and saves once to the header and the sidebar", async () => {
    const puts = [];
    const { socket } = await loadPage({ fetch: editorFetch(puts) });
    socket.open();
    socket.receive(historyFrame());
    socket.receive({ type: "agent", mascot: KELPIE });
    const row = $("roster").querySelector('[data-agent="assistant"]');
    const pen = row.querySelector(".pen");
    expect(pen.getAttribute("aria-label")).toBe("Edit Assistant");
    pen.click();
    expect($("editor")).not.toBeNull();
    expect(pen.getAttribute("aria-expanded")).toBe("true");
    const header = $("mascot").mascot;
    const jump = vi.spyOn(header, "change");

    const radios = [...$("editor").querySelectorAll("[aria-label='Shape'] [role='radio']")];
    radios[1].click();
    const tab = [...$("editor").querySelectorAll("[role='tab']")].find((each) =>
      each.textContent.startsWith("Profile"),
    );
    tab.click();
    const name = $("editor-name");
    name.value = "Kelpie";
    name.dispatchEvent(new Event("input"));
    $("editor").querySelector(".save").click();
    await settle();

    const bubble = { ...KELPIE, shape: "bubble" };
    expect(puts).toEqual([
      {
        url: "/webchat/agents/assistant/profile",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: { name: "Kelpie" },
      },
      {
        url: "/webchat/agents/assistant/mascot",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: bubble,
      },
    ]);
    // The header's mascot plays the change's jump, and the name follows everywhere.
    expect(jump).toHaveBeenCalledWith(bubble);
    expect($("agent-name").textContent).toBe("Kelpie");
    expect(row.querySelector(".row-link").textContent).toBe("Kelpie");
    expect(document.title).toBe("Kelpie");
    vi.advanceTimersByTime(APPROVED_MS);
    expect($("editor")).toBeNull();
    expect(pen.getAttribute("aria-expanded")).toBe("false");
    expect($("toasts").textContent).toContain("Kelpie: profile and mascot saved");
  });

  it("puts the open agent's pencil at rest in the switcher, and opens the sheet there", async () => {
    const narrow = narrowScreen();
    vi.spyOn(history, "back").mockImplementation(() => {});
    await loadPage({ search: "?agent=agenda", fetch: editorFetch([]) });
    narrow.mockRestore();
    $("switcher").click();
    const items = [...$("agents").querySelectorAll("li")];
    // Each agent's name carries its specialty; Master's is the page's own.
    expect(items.map((item) => item.querySelector(".agent-label").textContent)).toEqual([
      "Assistant Master",
      "Agenda Agenda e e-mail",
    ]);
    expect(items[0].querySelector(".pen")).toBeNull();
    const pen = items[1].querySelector(".pen.at-rest");
    expect(pen.getAttribute("aria-label")).toBe("Edit Agenda");
    pen.click();
    // The switcher closes, never a sheet over a sheet (NN/g).
    expect($("switcher").getAttribute("aria-expanded")).toBe("false");
    expect($("editor").classList.contains("sheet")).toBe(true);
    expect($("editor").getAttribute("aria-label")).toBe("Edit Agenda");
    expect(pen.getAttribute("aria-expanded")).toBe("true");
    $("editor").querySelector(".icb.close").click();
    expect(pen.getAttribute("aria-expanded")).toBe("false");
    vi.restoreAllMocks();
  });

  it("opens the switcher for a single agent below the sidebar's width, its one way to the editor", async () => {
    const narrow = narrowScreen();
    await loadPage({ search: "?agent=assistant", fetch: editorFetch([], [AGENTS[0]]) });
    narrow.mockRestore();
    const switcher = $("switcher");
    expect(switcher.getAttribute("aria-disabled")).toBe("false");
    expect(switcher.getAttribute("aria-label")).toBe("Assistant, Agents");
    switcher.click();
    expect($("agents").hidden).toBe(false);
    expect($("agents").querySelector(".pen.at-rest").getAttribute("aria-label")).toBe(
      "Edit Assistant",
    );
  });
});
