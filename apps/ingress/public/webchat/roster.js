// The sidebar's roster (docs/design-system.md 5.9, ADR-0052): every agent the owner can talk to, in
// the Registry's order, which no state changes. A row shows its agent's mascot at 36 px, its name,
// a line with 5.9's glyph, its state and what it does, and a time. A waiting row's state opens its
// request under the row, with 5.3's card. The open conversation's row follows that conversation's
// own socket; every other row, up to 16, follows a presence socket of its own.

import { Card, defaultTimers } from "./card.js";
import { icon } from "./icons.js";
import { Mascot } from "./mascot.js";
import { isDrawable } from "./mascot-art.js";
import { APPROVED_MS } from "./mascot-states.js";
import { retryDelay } from "./model.js";
import { enter, hideAfterExit, play, reduced, SPRINGS } from "./motion.js";
import { PresenceLink, rowAfter, rowAt, rowLine, rowMascot, UNKNOWN } from "./presence.js";
import { roll } from "./roll.js";

/** The rows that follow their agent; past them, a row shows its mascot and name only. */
export const FOLLOWED_AT_MOST = 16;
/** A folded card's receipt shows this long before its request closes. */
export const RECEIPT_SHOWN_MS = 1_600;

const SVG = "http://www.w3.org/2000/svg";

/** 5.9's glyphs, drawn at 10 px; their colors come from the stylesheet. */
const GLYPHS = {
  idle: [["circle", { cx: 5, cy: 5, r: 3.75, class: "ring" }]],
  working: [
    ["circle", { cx: 5, cy: 5, r: 3.75, class: "ring" }],
    ["path", { d: "M5 1.25a3.75 3.75 0 0 1 0 7.5z", class: "fill" }],
  ],
  waiting: [["path", { d: "M5 1l4 4-4 4-4-4z", class: "fill" }]],
  error: [["path", { d: "M5 1.3l4 7.2H1z", class: "fill" }]],
  offline: [
    ["circle", { cx: 5, cy: 5, r: 3.75, class: "ring" }],
    ["path", { d: "M2.4 7.6l5.2-5.2", class: "line" }],
  ],
  paused: [["path", { d: "M3 2v6M7 2v6", class: "line" }]],
};

export function glyph(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("class", "glyph");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.glyph = name;
  for (const [tag, attributes] of GLYPHS[name] ?? []) {
    const shape = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
    svg.append(shape);
  }
  return svg;
}

const element = (tag, className) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  return made;
};

export class Roster {
  #list;
  #strip;
  #note;
  #texts;
  #locale;
  #socket;
  #now;
  #timers;
  #less;
  #onWaiting;
  #onRefused;
  #onAnnounce;
  #openOwnCard;
  /** The rows by agent id, in the list's order. */
  #rows = new Map();
  #current = "";
  #pageOffline = false;
  #waiting = 0;
  #ticker = null;
  #refusing = false;
  /** Reloads of the list in a row with no row coming back between them, for their backoff. */
  #reloads = 0;
  /** The open conversation's row, which its socket may bring before the list names it. */
  #ownState = UNKNOWN;
  #ids = 0;

  /**
   * @param {HTMLElement} nav the roster's `<nav>`, holding its `<ul>`
   * @param {{
   *   texts: object, locale: string, strip: HTMLElement, note: HTMLElement,
   *   socket: { host: string, lang: string, secure: boolean, isHidden: () => boolean },
   *   less: () => boolean, onWaiting: (count: number) => void, onRefused: () => void,
   *   onAnnounce: (text: string) => void, openOwnCard: () => boolean,
   *   now?: () => number, timers?: typeof defaultTimers,
   * }} options
   */
  constructor(nav, options) {
    this.#list = nav.querySelector("ul");
    this.#strip = options.strip;
    this.#note = options.note;
    this.#texts = options.texts;
    this.#locale = options.locale;
    this.#socket = options.socket;
    this.#less = options.less;
    this.#onWaiting = options.onWaiting;
    this.#onRefused = options.onRefused;
    this.#onAnnounce = options.onAnnounce;
    this.#openOwnCard = options.openOwnCard;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? defaultTimers;
    nav.addEventListener("keydown", (event) => this.#key(event));
    nav.addEventListener("focusin", (event) => {
      const row = this.#rowOf(event.target);
      if (row && event.target === row.link) this.#rove(row);
    });
  }

  /**
   * The agents the list names, in the Registry's order, and the one this page shows. A row the
   * list no longer names leaves; the others keep their place and their socket.
   */
  setAgents(agents, current) {
    this.#current = current;
    const listed = new Set(agents.map((agent) => agent.id));
    for (const [id, row] of this.#rows) {
      if (listed.has(id)) continue;
      this.#drop(row);
      this.#rows.delete(id);
    }
    // The open conversation counts among the 16, though its own socket follows it.
    let followed = agents.some((agent) => agent.id === current) ? 1 : 0;
    let past = false;
    let previous = null;
    const rows = new Map();
    for (const agent of agents) {
      const row = this.#rows.get(agent.id) ?? this.#row(agent);
      rows.set(agent.id, row);
      // In the list's order; a row already in place isn't moved, so focus stays on it.
      const before = previous ? previous.li.nextSibling : this.#list.firstChild;
      if (before !== row.li) this.#list.insertBefore(row.li, before);
      previous = row;
      if (row.agent.name !== agent.name) row.link.textContent = agent.name;
      row.agent = agent;
      if (!row.mascot && isDrawable(agent.mascot)) {
        row.mascot = new Mascot(row.host, { mascot: agent.mascot, px: 36, mode: "list" });
      }
      row.current = agent.id === current;
      if (row.current) row.link.setAttribute("aria-current", "page");
      else row.link.removeAttribute("aria-current");
      if (row.current) {
        row.followed = true;
        row.follow?.close();
        row.follow = null;
        row.state = this.#ownState;
      } else if (followed < FOLLOWED_AT_MOST) {
        followed += 1;
        row.followed = true;
        if (row.follow) row.follow.retry();
        else this.#follow(row);
      } else {
        past = true;
        row.followed = false;
        row.follow?.close();
        row.follow = null;
        row.state = UNKNOWN;
      }
    }
    this.#rows = rows;
    this.#note.hidden = !past;
    this.#note.textContent = past ? this.#texts.rosterPast(FOLLOWED_AT_MOST) : "";
    const focused = [...rows.values()].find((row) => row.link.tabIndex === 0);
    this.#rove(focused ?? rows.get(current) ?? rows.values().next().value);
    this.#refresh({ instant: true });
  }

  /**
   * A frame of the open conversation's own socket, which its row follows. The socket may open
   * before the list names the row, so the row's state is kept until it does.
   */
  own(frame) {
    const mapped = ownFrame(frame);
    if (!mapped) return;
    const row = this.#rows.get(this.#current);
    if (row) {
      this.#apply(row, mapped);
      this.#ownState = row.state;
    } else if (mapped.type !== "confirmation") {
      this.#ownState = rowAfter(this.#ownState, mapped, this.#now());
    }
  }

  /** The page lost its own socket, or has it back: every row says no connection meanwhile. */
  offline(lost) {
    if (this.#pageOffline === lost) return;
    this.#pageOffline = lost;
    this.#refresh();
  }

  /** The page's own socket came back, or the owner chose "Try now": each row's backoff restarts. */
  reconnect() {
    for (const row of this.#rows.values()) row.follow?.reconnect();
  }

  /** The list couldn't be read again: each row that lost its socket retries with its backoff. */
  retry() {
    for (const row of this.#rows.values()) row.follow?.retry();
  }

  /** The page shows again: retries held while it was hidden run. */
  wake() {
    for (const row of this.#rows.values()) row.follow?.wake();
  }

  // ── Rows ────────────────────────────────────────────────────────────────────────────────────

  #row(agent) {
    const id = `row-${++this.#ids}`;
    const li = element("li", "roster-row");
    li.dataset.agent = agent.id;
    li.dataset.state = "unknown";
    const box = element("div", "arow");
    const avatar = element("span", "avw");
    const host = element("span", "mascot-host");
    host.setAttribute("aria-hidden", "true");
    avatar.append(host);
    const who = element("span", "an");
    const link = element("a", "row-link");
    link.href = `?agent=${encodeURIComponent(agent.id)}`;
    link.textContent = agent.name;
    link.tabIndex = -1;
    const line = element("span", "ast");
    const mark = element("span", "glyph-slot");
    const words = element("span", "t");
    words.id = `${id}-state`;
    const label = element("span", "lbl");
    const detail = element("span", "det");
    words.append(label, detail);
    // A waiting row's state is a disclosure: it opens the request under the row.
    const open = element("button", "row-open");
    open.type = "button";
    open.hidden = true;
    open.tabIndex = -1;
    open.setAttribute("aria-expanded", "false");
    open.setAttribute("aria-controls", `${id}-request`);
    open.setAttribute("aria-labelledby", words.id);
    line.append(mark, words, open);
    const time = element("span", "atime");
    time.id = `${id}-time`;
    link.setAttribute("aria-describedby", `${words.id} ${time.id}`);
    who.append(link, line);
    box.append(avatar, who, time);
    const request = element("div", "row-request");
    request.id = `${id}-request`;
    request.hidden = true;
    li.append(box, request);
    const row = {
      agent,
      li,
      link,
      host,
      mascot: null,
      mark,
      label,
      detail,
      time,
      open,
      request,
      state: UNKNOWN,
      follow: null,
      followed: false,
      current: false,
      card: null,
      focusInside: false,
      approvedUntil: 0,
      glyph: null,
    };
    open.addEventListener("click", (event) => this.#toggle(row, { keyboard: event.detail === 0 }));
    // Whether the owner is in the request, which a fold or a close takes from under them.
    request.addEventListener("focusin", () => {
      row.focusInside = true;
    });
    request.addEventListener("focusout", (event) => {
      if (event.relatedTarget && !request.contains(event.relatedTarget)) row.focusInside = false;
    });
    return row;
  }

  #follow(row) {
    row.follow = new PresenceLink(row.agent.id, {
      ...this.#socket,
      onFrame: (frame) => {
        // A row that reads its state again ends a run of refusals.
        if (frame.type === "presence") this.#reloads = 0;
        this.#apply(row, frame);
      },
      onRefused: () => this.#refused(),
    });
    row.follow.open();
  }

  #drop(row) {
    row.follow?.close();
    row.card?.dispose();
    row.li.remove();
  }

  /**
   * Every row that refused at once asks for one reload of the list. Reloads in a row with no row
   * coming back wait the page's backoff, so a conversation that keeps refusing can't keep asking.
   */
  #refused() {
    if (this.#refusing) return;
    this.#refusing = true;
    const delay = this.#reloads === 0 ? 0 : retryDelay(this.#reloads, this.#socket.random);
    this.#reloads += 1;
    this.#timers.set(() => {
      this.#refusing = false;
      this.#onRefused();
    }, delay);
  }

  #apply(row, frame) {
    const now = this.#now();
    if (frame.type === "confirmation") {
      if (row.card?.id === frame.id) row.card.confirmation(frame.status);
      if (frame.status === "accepted") {
        // 5.3: Approved for 1.1 s, then what the row's state says.
        row.approvedUntil = now + APPROVED_MS;
        row.mascot?.setState("approved");
        this.#timers.set(() => this.#render(row), APPROVED_MS);
      }
      return;
    }
    row.state = rowAfter(row.state, frame, now);
    this.#render(row);
    this.#count();
  }

  #refresh({ instant = false } = {}) {
    for (const row of this.#rows.values()) this.#render(row, { instant });
    this.#count();
  }

  /** What the row shows now: its line, its glyph, its time and its mascot. */
  #render(row, { instant = false } = {}) {
    const now = this.#now();
    row.state = rowAt(row.state, now);
    const shown = this.#shown(row, now);
    const line = rowLine(shown, this.#texts, now, { less: this.#less() });
    row.li.dataset.state = shown.state;
    if (row.glyph !== line.glyph) {
      row.glyph = line.glyph;
      row.mark.replaceChildren(...(line.glyph ? [glyph(line.glyph)] : []));
    }
    // The line rolls (5.9), unless it draws at once.
    if (instant || this.#less()) row.label.replaceChildren();
    roll(row.label, line.label);
    row.detail.textContent = line.detail ? ` · ${line.detail}` : "";
    row.time.textContent = line.time;
    const waiting = shown.state === "waiting";
    row.open.hidden = !waiting;
    if (!row.request.hidden) this.#keepRequest(row);
    if (row.mascot && now >= row.approvedUntil) {
      const pose = rowMascot(shown);
      row.mascot.setState(pose.state, { activity: pose.activity, instant });
    }
    this.#tick();
  }

  #shown(row, now) {
    if (!row.followed) return UNKNOWN;
    return this.#pageOffline ? rowAfter(row.state, { type: "offline" }, now) : row.state;
  }

  /** The times count while a row works or waits; nothing ticks otherwise. */
  #tick() {
    const counting = [...this.#rows.values()].some((row) =>
      ["working", "waiting"].includes(row.li.dataset.state),
    );
    if (counting && this.#ticker === null) {
      this.#ticker = this.#timers.every(() => this.#counted(), 1_000);
    } else if (!counting && this.#ticker !== null) {
      this.#timers.stop(this.#ticker);
      this.#ticker = null;
    }
  }

  #counted() {
    for (const row of this.#rows.values()) {
      if (["working", "waiting"].includes(row.li.dataset.state)) this.#render(row);
    }
    this.#count();
  }

  // ── What waits for the owner (5.9) ──────────────────────────────────────────────────────────

  /** The strip counts the agents waiting, in its reserved slot, and the page's title follows. */
  #count() {
    const count = [...this.#rows.values()].filter(
      (row) => row.li.dataset.state === "waiting",
    ).length;
    if (count === this.#waiting) return;
    const appearing = this.#waiting === 0 || this.#strip.dataset.leaving !== undefined;
    this.#waiting = count;
    this.#onWaiting(count);
    if (count === 0) {
      hideAfterExit(this.#strip);
      return;
    }
    delete this.#strip.dataset.leaving;
    const text = this.#texts.strip(count);
    const digits = text.match(/\d+/);
    let number = this.#strip.querySelector(".count");
    let words = this.#strip.querySelector(".words");
    if (!number) {
      number = element("span", "count");
      words = element("span", "words");
      const line = element("span", "strip-text");
      line.append(number, words);
      this.#strip.append(icon("bell"), line);
    }
    // The count rolls (5.9), unless the strip is just appearing.
    if (appearing || reduced()) number.replaceChildren();
    roll(number, digits[0]);
    words.textContent = text.slice(digits.index + digits[0].length);
    this.#strip.hidden = false;
    if (appearing) enter(this.#strip, { spring: SPRINGS.fast });
  }

  // ── A waiting row's request (5.9 "A row opens in place") ─────────────────────────────────────

  #toggle(row, { keyboard }) {
    if (row.request.hidden) this.#openRequest(row, { keyboard });
    else this.#closeRequest(row);
  }

  #openRequest(row, { keyboard }) {
    // The open conversation's request is in its thread: the disclosure goes to its card there.
    if (row.current) {
      this.#openOwnCard();
      return;
    }
    const request = row.state.requests[0];
    if (!request || !row.request.hidden) return;
    const bubble = element("div", "bubble row-card");
    const text = element("div", "text");
    text.textContent = request.summary;
    bubble.append(text);
    // In the page before the card draws its mascot, which reads its color from the page.
    row.request.replaceChildren(bubble);
    row.request.hidden = false;
    row.card = new Card(bubble, {
      id: request.id,
      until: request.expiresAt,
      who: row.agent.name,
      texts: this.#texts,
      locale: this.#locale,
      onConfirm: (id) => row.follow?.confirm(id) ?? false,
      onPause: () => row.follow?.pause() ?? false,
      mascot: (host) => {
        if (isDrawable(row.agent.mascot)) {
          new Mascot(host, { mascot: row.agent.mascot, px: 40, mode: "still", state: "waiting" });
        }
      },
      onAnnounce: this.#onAnnounce,
      onChange: (change) => {
        if (change.kind !== "receipt") return;
        // The fold took the focused button: focus goes back to the row, and stays on the list.
        this.#keepFocus(row);
        this.#timers.set(() => this.#closeRequest(row), RECEIPT_SHOWN_MS);
      },
      now: this.#now,
      timers: this.#timers,
    });
    row.open.setAttribute("aria-expanded", "true");
    // It grows under the row with --spring-moment; from the keyboard it appears at once.
    if (keyboard) return;
    if (reduced()) {
      play(row.request, [{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
      return;
    }
    const height = row.request.getBoundingClientRect().height;
    play(
      row.request,
      [
        { height: "0px", opacity: 0 },
        { height: `${height}px`, opacity: 1 },
      ],
      {
        duration: SPRINGS.moment.duration,
        easing: SPRINGS.moment.easing,
      },
    );
  }

  #closeRequest(row) {
    if (row.request.hidden) return;
    row.card?.dispose();
    row.card = null;
    row.request.hidden = true;
    row.request.replaceChildren();
    row.open.setAttribute("aria-expanded", "false");
    this.#keepFocus(row);
    row.focusInside = false;
  }

  /** Focus in the request, or lost from it to the page, returns to its row's link. */
  #keepFocus(row) {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (row.request.contains(active) || (row.focusInside && lost)) row.link.focus();
  }

  /** An open request stays while its card is open, or folding; one answered elsewhere closes. */
  #keepRequest(row) {
    const card = row.card;
    if (!card) return;
    if (!card.open || card.pressed) return;
    if (!row.state.requests.some((request) => request.id === card.id)) this.#closeRequest(row);
  }

  // ── The keyboard: one tab stop, ↑ ↓ Home End to move, → and ← for a request ──────────────────

  #rove(row) {
    if (!row) return;
    for (const other of this.#rows.values()) other.link.tabIndex = other === row ? 0 : -1;
  }

  #rowOf(target) {
    if (!(target instanceof Element)) return null;
    const li = target.closest(".roster-row");
    return [...this.#rows.values()].find((row) => row.li === li) ?? null;
  }

  #key(event) {
    const row = this.#rowOf(event.target);
    if (!row) return;
    if (event.target !== row.link) {
      if (event.key === "Escape" && !row.request.hidden) {
        event.preventDefault();
        this.#closeRequest(row);
      }
      return;
    }
    const rows = [...this.#rows.values()];
    const index = rows.indexOf(row);
    const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[
      event.key
    ];
    if (to !== undefined) {
      event.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      this.#rove(next);
      next.link.focus();
      return;
    }
    if (event.key === "ArrowRight" && !row.open.hidden) {
      event.preventDefault();
      this.#openRequest(row, { keyboard: true });
    } else if ((event.key === "ArrowLeft" || event.key === "Escape") && !row.request.hidden) {
      event.preventDefault();
      this.#closeRequest(row);
    }
  }
}

/** The open conversation's frames, as its row reads them: its history starts it. */
function ownFrame(frame) {
  switch (frame.type) {
    case "history":
      return {
        type: "presence",
        turn: null,
        failed: false,
        paused: Boolean(frame.paused),
        requests: [],
        more: 0,
      };
    case "status":
    case "paused":
    case "resumed":
    case "requests":
    case "confirmation":
      return frame;
    case "typing":
      return frame.active ? { type: "status", status: "typing" } : null;
    // A reply ends its turn, as the header's mascot reads it; a failed one is an error.
    case "bubble":
      return frame.failed ? { type: "failed" } : { type: "status", status: "idle" };
    default:
      return null;
  }
}
