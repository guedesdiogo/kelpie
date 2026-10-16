// The sidebar's rows follow their agents (ADR-0050). Each row has a presence socket of its own:
// it takes only the frames that view allows, starts unknown rather than idle, and shows Offline once
// its socket has been closed 2 s, because the row can't vouch for its agent's state any more.

import { retryDelay } from "./model.js";

/** What a presence socket may bring (ADR-0050 §2). Every other frame is dropped. */
const PRESENCE_FRAMES = new Set([
  "presence",
  "status",
  "failed",
  "paused",
  "resumed",
  "requests",
  "confirmation",
]);

/** A row shows Offline once its socket has been closed this long. */
export const OFFLINE_AFTER_MS = 2_000;
/** A socket that closes sooner than this after it was opened counts as a failed attempt. */
const QUICK_MS = 5_000;

// ── A row's state (5.9) ────────────────────────────────────────────────────────────────────────

/** A row before its presence frame: it shows no state, and is never Idle by default. */
export const UNKNOWN = Object.freeze({
  state: "unknown",
  known: false,
  offline: false,
  /** When the running turn began, its latest step and that step's label. */
  since: null,
  step: null,
  label: null,
  failed: false,
  paused: false,
  /** The open confirmations, newest first, with when they were asked and when they expire. */
  requests: [],
  more: 0,
});

/** What the row shows, in order: Offline, then a request waiting, then work, then the rest. */
function stateOf(row) {
  if (row.offline) return "offline";
  if (!row.known) return "unknown";
  if (row.requests.length > 0) return "waiting";
  if (row.since !== null) return "working";
  if (row.paused) return "paused";
  if (row.failed) return "error";
  return "idle";
}

function openOf(frame, now) {
  return {
    requests: frame.requests.map((request) => ({
      id: request.id,
      summary: request.summary,
      askedAt: now - request.askedAgoMs,
      expiresAt: now + request.expiresInMs,
    })),
    more: frame.more,
  };
}

/**
 * The row at `now`. The conversation says nothing when a request expires, so the row drops it on
 * its own clock; the others the list didn't show were asked earlier, and have expired too.
 */
export function rowAt(row, now) {
  const requests = row.requests.filter((request) => request.expiresAt > now);
  const next = requests.length === row.requests.length ? { ...row } : { ...row, requests, more: 0 };
  next.state = stateOf(next);
  return next;
}

/** The row after one of its socket's frames, or `{type: "offline"}` from the link. */
export function rowAfter(row, frame, now) {
  let next;
  switch (frame.type) {
    case "presence":
      next = {
        ...UNKNOWN,
        known: true,
        since: frame.turn ? now - frame.turn.agoMs : null,
        step: frame.turn?.step ?? null,
        label: frame.turn?.label ?? null,
        failed: frame.failed,
        paused: frame.paused,
        ...openOf(frame, now),
      };
      break;
    case "status":
      next =
        frame.status === "idle"
          ? { ...row, since: null, step: null, label: null }
          : {
              ...row,
              since: row.since ?? now,
              step: frame.status,
              label: frame.label ?? null,
              failed: false,
            };
      break;
    case "failed":
      next = { ...row, since: null, step: null, label: null, failed: true };
      break;
    case "paused":
      next = { ...row, paused: true };
      break;
    case "resumed":
      next = { ...row, paused: false };
      break;
    case "requests":
      next = { ...row, ...openOf(frame, now) };
      break;
    case "offline":
      next = { ...row, offline: true };
      break;
    default:
      // What a press did shows on its card, not on the row.
      return row;
  }
  return rowAt(next, now);
}

/** A running turn's time, as m:ss. */
function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * What the row's line says: its state's glyph and words, what it is about, and a time. The page
 * sets each as text, since a request's summary is the tool's own words.
 */
export function rowLine(row, texts, now) {
  const line = (glyph, label, detail = "", time = "") => ({ glyph, label, detail, time });
  switch (row.state) {
    case "working":
      return line(
        "working",
        texts.rowWorking,
        row.label ?? (row.step ? (texts.steps[row.step] ?? "") : ""),
        elapsed(now - row.since),
      );
    case "waiting": {
      const newest = row.requests[0];
      return line(
        "waiting",
        texts.rowWaiting,
        newest.summary,
        texts.ago(Math.floor((now - newest.askedAt) / 60_000)),
      );
    }
    case "paused":
      return line("paused", texts.rowPaused);
    case "error":
      return line("error", texts.rowError);
    case "offline":
      return line("offline", texts.rowOffline);
    case "idle":
      return line("idle", texts.rowIdle, texts.rowNoTask);
    default:
      return line(null, "");
  }
}

// ── A row's socket (ADR-0050 §5) ───────────────────────────────────────────────────────────────

/**
 * One agent's presence socket. A closed socket retries with the page's backoff; a refusal, or a
 * socket that never opened, calls `onRefused` instead, so the page reloads its list once for every
 * row. The browser can't tell a refusal from a dropped network: both close with 1006. A socket the
 * conversation's cap closed (1013) waits for `reconnect`, so two tabs can't evict each other in turn.
 */
export class PresenceLink {
  #agent;
  #url;
  #onFrame;
  #onRefused;
  #isHidden;
  #random;
  #socket = null;
  #attempt = 0;
  #retryTimer;
  #offlineTimer;
  /** null while the row vouches for its state, "pending" for 2 s after a close, then "shown". */
  #lost = null;
  /** A retry came due while the page was hidden. */
  #due = false;
  #closed = false;

  constructor(
    agent,
    { host, lang, secure = true, onFrame, onRefused, isHidden = () => false, random = Math.random },
  ) {
    this.#agent = agent;
    this.#url = `${secure ? "wss" : "ws"}://${host}/webchat/ws?agent=${encodeURIComponent(agent)}&view=presence&lang=${encodeURIComponent(lang)}`;
    this.#onFrame = onFrame;
    this.#onRefused = onRefused;
    this.#isHidden = isHidden;
    this.#random = random;
  }

  open() {
    if (this.#closed) return;
    clearTimeout(this.#retryTimer);
    this.#due = false;
    const previous = this.#socket;
    this.#socket = null;
    previous?.close();
    const opened = Date.now();
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    let wasOpen = false;
    socket.addEventListener("open", () => {
      wasOpen = true;
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!frame || !PRESENCE_FRAMES.has(frame.type)) return;
      // Its presence frame says what the conversation knows now: the row vouches for it again.
      if (frame.type === "presence") {
        clearTimeout(this.#offlineTimer);
        this.#lost = null;
      }
      this.#onFrame(frame);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#lost === null) {
        this.#lost = "pending";
        this.#offlineTimer = setTimeout(() => {
          this.#lost = "shown";
          this.#onFrame({ type: "offline" });
        }, OFFLINE_AFTER_MS);
      }
      if (event.code === 1013) return;
      if (event.code === 1008 || !wasOpen) {
        this.#onRefused();
        return;
      }
      if (Date.now() - opened >= QUICK_MS) this.#attempt = 0;
      this.retry();
    });
  }

  /** Opens again after the backoff; each try in a row waits longer. */
  retry() {
    if (this.#closed) return;
    const delay = retryDelay(this.#attempt, this.#random);
    this.#attempt += 1;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      if (this.#isHidden()) this.#due = true;
      else this.open();
    }, delay);
  }

  /** The page's own socket came back, or the owner chose "Try now": the backoff starts again. */
  reconnect() {
    this.#attempt = 0;
    if (!this.#socket) this.open();
  }

  /** The page shows again: a retry that came due while it was hidden runs now. */
  wake() {
    if (this.#due && !this.#isHidden()) this.open();
  }

  /** The row left the list: nothing more from this socket reaches the page. */
  close() {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#offlineTimer);
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }

  #send(frame) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(frame));
    return true;
  }

  /** A press of a card's Confirm, over the socket the card came from. */
  confirm(id) {
    return this.#send({ type: "confirm", id, agent: this.#agent });
  }

  pause() {
    return this.#send({ type: "pause", agent: this.#agent });
  }
}
