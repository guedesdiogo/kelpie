import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, AGENTS, FakeSocket, fakeFetch, historyFrame, loadPage, settle } from "./harness.js";

const NOW = new Date(2026, 9, 15, 14, 32).getTime();

beforeEach(() => {
  vi.useFakeTimers({
    now: NOW,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function connected() {
  const page = await loadPage();
  page.socket.open();
  page.socket.receive(historyFrame());
  vi.advanceTimersByTime(500);
  await settle();
  return page;
}

describe("loading (5.11)", () => {
  it("shows nothing for 200 ms, then a skeleton that stays at least 400 ms", async () => {
    const { socket } = await loadPage();
    expect($("skeleton").hidden).toBe(true);
    vi.advanceTimersByTime(200);
    expect($("skeleton").hidden).toBe(false);
    socket.open();
    socket.receive(historyFrame([{ role: "assistant", text: "Oi.", at: NOW }]));
    vi.advanceTimersByTime(399);
    expect($("skeleton").hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect($("skeleton").hidden).toBe(true);
    expect($("thread").getAttribute("aria-busy")).toBe("false");
  });

  it("leaves the screen to the connection banner past 10 s", async () => {
    await loadPage();
    vi.advanceTimersByTime(10_000);
    expect($("skeleton").hidden).toBe(true);
    expect($("banner").hidden).toBe(false);
    // Nothing is scheduled while the first socket still connects: no counting number.
    expect($("banner-text").textContent).toBe("No connection. Trying again shortly");
  });
});

describe("a lost connection (5.12)", () => {
  it("changes nothing for 2 s, then a banner counts down to the next try", async () => {
    const { socket } = await connected();
    // The socket and two retries fail; the waits grow, from 300 ms to 600 ms to 1.2 s.
    socket.close();
    vi.advanceTimersByTime(300);
    FakeSocket.last.close();
    vi.advanceTimersByTime(600);
    FakeSocket.last.close();
    vi.advanceTimersByTime(1_099);
    expect($("banner").hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect($("banner").hidden).toBe(false);
    expect($("banner").dataset.state).toBe("offline");
    // The first retry waits half of 600 ms here; the banner shows the time left.
    expect($("banner-text").textContent).toMatch(/^No connection\. Trying again in \d+ s$/);
    expect($("banner-text").querySelector(".digits")).not.toBeNull();
    expect($("status").textContent).toBe("No connection");
  });

  it("tries again now on Try now, and says it is back with what went out", async () => {
    const { socket } = await connected();
    socket.close();
    vi.advanceTimersByTime(2_000);
    // Written while offline: queued, and sent once the connection is back.
    $("text").value = "fila";
    $("composer").requestSubmit();
    expect(document.querySelector(".mark").textContent).toBe("Queued");

    $("retry").click();
    const next = FakeSocket.last;
    expect(next).not.toBe(socket);
    next.open();
    next.receive(historyFrame());
    expect(next.sentOf("message")).toEqual([expect.objectContaining({ text: "fila" })]);
    expect($("banner").dataset.state).toBe("back");
    expect($("banner-text").textContent).toBe("Back. 1 message sent.");
    expect($("status").textContent).toBe("");
    // Announcements stay quiet for 4 s after reconnecting.
    next.receive({ type: "bubble", text: "Chegou." });
    expect($("announcer").textContent).not.toContain("Chegou.");
    vi.advanceTimersByTime(2_600);
    expect($("banner").hidden).toBe(true);
    vi.advanceTimersByTime(1_400);
    next.receive({ type: "bubble", text: "Agora sim." });
    expect($("announcer").textContent).toBe("Assistant: Agora sim.");
  });

  it("closes a socket still connecting when Try now opens another, and hears only the new one", async () => {
    const { socket } = await connected();
    socket.close();
    vi.advanceTimersByTime(2_000);
    const connecting = FakeSocket.last;
    $("retry").click();
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(connecting);
    expect(connecting.readyState).toBe(3);
    connecting.open();
    fresh.open();
    fresh.receive(historyFrame());
    connecting.receive({ type: "bubble", text: "Do socket velho." });
    fresh.receive({ type: "bubble", text: "Do novo." });
    expect($("thread").textContent).not.toContain("Do socket velho.");
    expect($("thread").textContent).toContain("Do novo.");
  });

  it("keeps the reader's place when a reconnect replays the history", async () => {
    const { socket } = await connected();
    const scroller = $("scroller");
    Object.defineProperty(scroller, "scrollHeight", { value: 3_000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    socket.close();
    vi.advanceTimersByTime(300);
    FakeSocket.last.open();
    FakeSocket.last.receive(historyFrame([{ role: "assistant", text: "Antiga.", at: NOW }]));
    expect(scroller.scrollTop).toBe(0);
  });

  it("reconnects on its own after the retry's wait, with no banner when it is quick", async () => {
    const { socket } = await connected();
    socket.close();
    vi.advanceTimersByTime(300);
    const next = FakeSocket.last;
    expect(next).not.toBe(socket);
    next.open();
    next.receive(historyFrame());
    expect($("banner").hidden).toBe(true);
    // A socket from before is ignored once a new one replaced it.
    socket.close();
  });

  it("says 'shortly' with no counting number under less motion", async () => {
    const { socket } = await connected();
    document.documentElement.setAttribute("data-reduced", "");
    socket.close();
    vi.advanceTimersByTime(2_000);
    expect($("banner-text").textContent).toBe("No connection. Trying again shortly");
  });

  it("can't pause while offline, and says so until dismissed", async () => {
    const { socket } = await connected();
    socket.close();
    expect($("pause").disabled).toBe(false);
    $("pause").click();
    expect(document.querySelector(".toast[data-error]").textContent).toContain(
      "No connection. Pause again once it's back.",
    );
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

const headerState = () => $("mascot").mascot?.state;

describe("Offline, when the page loses its connection (ADR-0047)", () => {
  it("shows when the banner enters, not before, and the new socket's history ends it", async () => {
    const { socket } = await connected();
    socket.receive({ type: "agent", mascot: KELPIE });
    socket.receive({ type: "status", status: "thinking" });
    expect(headerState()).toBe("working");
    socket.close();
    vi.advanceTimersByTime(1_999);
    // The page can't vouch for the turn, but Offline waits for the banner (5.12).
    expect(headerState()).toBe("working");
    vi.advanceTimersByTime(1);
    expect($("banner").hidden).toBe(false);
    expect(headerState()).toBe("offline");
    $("retry").click();
    FakeSocket.last.open();
    FakeSocket.last.receive(historyFrame());
    expect(headerState()).toBe("idle");
  });

  it("shows on the expired-login dialog, at 160 px, holding its plug", async () => {
    const fetch = fakeFetch();
    const page = await loadPage({ fetch });
    page.socket.open();
    page.socket.receive(historyFrame());
    page.socket.receive({ type: "agent", mascot: KELPIE });
    fetch.mockImplementation(async (url) =>
      url === "/webchat/agents"
        ? { type: "opaqueredirect", status: 0, ok: false }
        : Response.json({ version: "1.2.3" }),
    );
    FakeSocket.last.close();
    vi.advanceTimersByTime(300);
    // A socket that never opened asks whether the login expired.
    FakeSocket.last.close();
    await settle();
    expect($("login").open).toBe(true);
    const shown = $("login-mascot").mascot;
    expect(shown.px).toBe(160);
    expect(shown.state).toBe("offline");
    // Behind the dialog, the header's mascot is Offline too.
    expect(headerState()).toBe("offline");
  });
});

describe("an expired login (5.12)", () => {
  it("opens the sign-in dialog when Access says the login expired, keeping the draft", async () => {
    const fetch = fakeFetch();
    const page = await loadPage({ fetch });
    fetch.mockImplementation(async (url) =>
      url === "/webchat/agents"
        ? { type: "opaqueredirect", status: 0, ok: false }
        : Response.json({ version: "1.2.3" }),
    );
    $("text").value = "não perca isto";
    // A socket that never opened.
    page.socket.close();
    await settle();
    expect($("login").open).toBe(true);
    expect(JSON.parse(sessionStorage.getItem("kelpie.webchat.assistant"))).toEqual({
      savedAt: NOW,
      draft: "não perca isto",
      unconfirmed: [],
    });
    const reload = vi.fn();
    vi.spyOn(location, "reload").mockImplementation(reload);
    $("sign-in").click();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("asks to sign in at once when the agents can't be listed for that reason", async () => {
    await loadPage({ fetch: fakeFetch({ agents: 401 }) });
    expect($("login").open).toBe(true);
  });

  it("brings the draft and unsent messages back after signing in", async () => {
    const page = await loadPage({
      session: {
        "kelpie.webchat.assistant": JSON.stringify({
          savedAt: NOW - 60_000,
          draft: "rascunho",
          unconfirmed: [["m-1", "enviada antes"], ["bad"]],
        }),
      },
    });
    expect($("text").value).toBe("rascunho");
    expect($("restored").hidden).toBe(false);
    expect($("restored").textContent).toBe("Restored your unsent message");
    expect(sessionStorage.getItem("kelpie.webchat.assistant")).toBeNull();
    page.socket.open();
    page.socket.receive(historyFrame());
    expect(page.socket.sentOf("message")).toEqual([
      { type: "message", id: "m-1", text: "enviada antes" },
    ]);
    // Sending hides the notice; leaving the page with nothing to keep stores nothing.
    $("composer").requestSubmit();
    expect($("restored").hidden).toBe(true);
    $("text").value = "";
    page.socket.receive({ type: "accepted", id: "m-1" });
    for (const [, frame] of page.socket.sentOf("message").entries()) {
      page.socket.receive({ type: "accepted", id: frame.id });
    }
    dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem("kelpie.webchat.assistant")).toBeNull();
  });

  it("survives a session store that holds garbage, and drops it", async () => {
    await loadPage({ session: { "kelpie.webchat.assistant": "{garbage" } });
    expect($("text").value).toBe("");
    expect(sessionStorage.getItem("kelpie.webchat.assistant")).toBeNull();
  });

  it("never sends an old message by itself: past 10 minutes it comes back as a draft", async () => {
    const page = await loadPage({
      session: {
        "kelpie.webchat.assistant": JSON.stringify({
          savedAt: NOW - 11 * 60_000,
          draft: "rascunho",
          unconfirmed: [["m-1", "apague X"]],
        }),
      },
    });
    // In the order they were written: the unsent message came before the draft.
    expect($("text").value).toBe("apague X\nrascunho");
    page.socket.open();
    page.socket.receive(historyFrame());
    expect(page.socket.sentOf("message")).toEqual([]);
  });

  it("restores only messages whose ids the conversation takes", async () => {
    const page = await loadPage({
      session: {
        "kelpie.webchat.assistant": JSON.stringify({
          savedAt: NOW,
          draft: "",
          unconfirmed: [
            ["bad:id", "dois pontos"],
            ["ok-1", "x".repeat(16_001)],
            ["ok-2", "certa"],
          ],
        }),
      },
    });
    page.socket.open();
    page.socket.receive(historyFrame());
    expect(page.socket.sentOf("message")).toEqual([{ type: "message", id: "ok-2", text: "certa" }]);
  });
});

describe("the agents (#140)", () => {
  it("opens the main agent when the address names none", async () => {
    const { socket } = await loadPage({ search: "" });
    expect(socket.url).toContain("agent=assistant");
    expect(location.search).toBe("?agent=assistant");
  });

  it("lists the agents to switch to, marking the current one", async () => {
    await loadPage();
    const switcher = $("switcher");
    expect(switcher.getAttribute("aria-disabled")).toBe("false");
    expect(switcher.getAttribute("aria-label")).toBe("Assistant, Switch agent");
    switcher.click();
    expect($("agents").hidden).toBe(false);
    const links = [...$("agents").querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      AGENTS.map((agent) => `?agent=${agent.id}`),
    );
    expect(links[1].getAttribute("aria-current")).toBe("page");
    expect(links[2].textContent).toBe("Agendaagenda");
  });

  it("opens the main agent instead of one the list doesn't name", async () => {
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    await loadPage({ search: "?agent=ghost" });
    expect(replace).toHaveBeenCalledWith("?agent=assistant");
  });

  it("offers no switcher with one agent", async () => {
    await loadPage({ fetch: fakeFetch({ agents: [AGENTS[1]] }) });
    expect($("switcher").getAttribute("aria-disabled")).toBe("true");
  });

  it("says when this login can't use the webchat, or no agent chats", async () => {
    await loadPage({ search: "", fetch: fakeFetch({ agents: 403 }) });
    expect($("status").textContent).toBe("This login can't use the webchat.");
    expect($("composer").hidden).toBe(true);
    expect(FakeSocket.all).toHaveLength(0);

    await loadPage({ search: "", fetch: fakeFetch({ agents: [] }) });
    expect($("status").textContent).toBe("No agent chats on the webchat yet.");
  });

  it("keeps working when the list can't be fetched", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const { socket } = await loadPage({ fetch });
    expect(socket.url).toContain("agent=assistant");
    expect($("agent-name").textContent).toBe("assistant");
    expect($("version").textContent).toBe("");
  });
});
