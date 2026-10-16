// Loads the webchat's page into the test's DOM with a fake socket and a fake fetch, so its modules
// run as they do in a browser (#140). Each test file gets a DOM of its own.

import { vi } from "vitest";
import PAGE from "../../public/webchat/index.html?raw";

/** The agents ingress lists, in the registry's order. */
export const AGENTS = [
  { id: "kelpie-setup", name: "Setup", main: false },
  { id: "assistant", name: "Assistant", main: true },
  { id: "agenda", name: "Agenda", main: false },
];

/** A WebSocket the test drives: it opens, receives frames and closes when told. */
export class FakeSocket {
  static OPEN = 1;
  static all = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.all.push(this);
  }

  static get last() {
    return FakeSocket.all.at(-1);
  }

  /** The newest socket a sidebar row opened for `agent` (ADR-0052). */
  static presence(agent) {
    return FakeSocket.all.findLast(
      (socket) => socket.url.includes("view=presence") && socket.url.includes(`agent=${agent}&`),
    );
  }

  /** The newest of the open conversation's own sockets. */
  static get own() {
    return FakeSocket.all.findLast((socket) => !socket.url.includes("view=presence"));
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  #emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  /** The frames of `type` the page sent. */
  sentOf(type) {
    return this.sent.filter((frame) => frame.type === type);
  }

  open() {
    this.readyState = 1;
    this.#emit("open");
  }

  receive(frame) {
    this.#emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  close(code = 1006) {
    this.readyState = 3;
    this.#emit("close", { code });
  }
}

/** A fetch answering /webchat/agents and /version; `agents` may be a status or a Response-like. */
export function fakeFetch({ agents = AGENTS } = {}) {
  return vi.fn(async (url) => {
    if (url === "/webchat/agents") {
      if (typeof agents === "number") return new Response(null, { status: agents });
      if (agents && typeof agents === "object" && "type" in agents) return agents;
      return Response.json({ agents });
    }
    if (url === "/version") return Response.json({ version: "1.2.3", commit: "abc1234" });
    return new Response(null, { status: 404 });
  });
}

/** Lets pending promises run; it works with fake timers too. */
export const settle = async () => {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
};

/**
 * Puts the page in the DOM, runs boot.js, and imports app.js afresh. `search` is the page's query;
 * `fetch` answers its requests; `storage` seeds sessionStorage and localStorage.
 */
export async function loadPage({
  search = "?agent=assistant",
  fetch = fakeFetch(),
  session = {},
  local = {},
} = {}) {
  vi.resetModules();
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = fetch;
  sessionStorage.clear();
  localStorage.clear();
  for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value);
  for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
  // The page's own stylesheets and scripts stay out: the project's DOM loads no file, and the
  // test imports the modules itself. The favicon's links stay, since the page swaps one (5.9).
  const parsed = new DOMParser().parseFromString(PAGE, "text/html");
  for (const node of parsed.querySelectorAll("link:not([rel='icon']), script")) node.remove();
  document.head.replaceChildren(
    ...[...parsed.head.childNodes].map((node) => document.importNode(node, true)),
  );
  document.body.replaceChildren(
    ...[...parsed.body.childNodes].map((node) => document.importNode(node, true)),
  );
  for (const attribute of [...document.documentElement.attributes]) {
    if (attribute.name.startsWith("data-"))
      document.documentElement.removeAttribute(attribute.name);
  }
  window.history.replaceState(null, "", `/webchat/${search}`);
  await import("../../public/webchat/boot.js");
  await import("../../public/webchat/app.js");
  await settle();
  return { socket: FakeSocket.last, fetch };
}

export const $ = (id) => document.getElementById(id);

/** The conversation's opening frame, as the runtime sends it. */
export const historyFrame = (messages = [], { received = [], paused = false } = {}) => ({
  type: "history",
  messages,
  received,
  paused,
});
