// The conversation as the page shows it (#140, docs/design-system.md §5.1 to §5.3 and §5.20):
// days, groups of one sender's bubbles, the marks under the owner's messages, the typing bubble
// that becomes the reply, a turn's tool row, and the confirmation card. Model output only ever
// reaches the page as text nodes and the blocks of blocks.js.

import { renderBlocks } from "./blocks.js";
import { Card, defaultTimers } from "./card.js";
import { icon } from "./icons.js";
import { CONFIRMATION_MS } from "./mascot-states.js";
import {
  clock,
  dayKey,
  dayLabel,
  elapsedText,
  markOf,
  SENDING_AFTER_MS,
  SPINNER_AFTER_MS,
  sameGroup,
  summaryText,
} from "./model.js";
import {
  DUR,
  EASE,
  enter,
  fadeIn,
  fromKeyboard,
  leave,
  play,
  REPLY_TEXT_DELAY,
  reduced,
  resize,
  SPRINGS,
} from "./motion.js";
import { roll, rollText } from "./roll.js";

/** At most this many of the latest messages slide up when one arrives below them (5.1). */
const FLIP_AT_MOST = 12;
/** At most this many steps of a row enter staggered; a stagger stops at 300 ms (§4.3). */
const STAGGER_MS = 30;
const STAGGER_UNTIL_MS = 300;

export class Thread {
  #root;
  #texts;
  #locale;
  #now;
  #timers;
  #agentName;
  #less;
  #onConfirm;
  #onPause;
  #cardMascot;
  #onAnnounce;
  #onChange;
  #days = new Map();
  /** The latest shown message: its sender, time and group, for the next to join or not. */
  #last;
  /** The owner's messages by the page's id, with what their mark depends on. */
  #owner = new Map();
  /** A confirmation's cards by its id: one for each notice of it. */
  #cards = new Map();
  #activity = null;
  #waiting = false;

  /**
   * @param {HTMLElement} root
   * @param {{
   *   texts: object, locale: string, agentName: () => string, less: () => boolean,
   *   onConfirm: (id: number) => boolean, onPause?: () => boolean,
   *   cardMascot?: (host: HTMLElement) => void, onAnnounce: (text: string) => void,
   *   onChange: (change: { kind: string, element: Element }) => void,
   *   now?: () => number, timers?: typeof defaultTimers,
   * }} options
   */
  constructor(root, options) {
    this.#root = root;
    this.#texts = options.texts;
    this.#locale = options.locale;
    this.#agentName = options.agentName;
    this.#less = options.less;
    this.#onConfirm = options.onConfirm;
    this.#onPause = options.onPause ?? (() => false);
    this.#cardMascot = options.cardMascot ?? (() => {});
    this.#onAnnounce = options.onAnnounce;
    this.#onChange = options.onChange;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? defaultTimers;
  }

  get isEmpty() {
    return this.#root.querySelector(".message, .tool-row") === null;
  }

  /** The cards still waiting for the owner, in the thread's order. */
  get openCards() {
    return [...this.#cards.values()].flat().filter((card) => card.open);
  }

  /** The agent's name changed, or arrived after the history: its groups' headings follow. */
  renamed() {
    for (const heading of this.#root.querySelectorAll('.group[data-sender="assistant"] > h3')) {
      heading.textContent = this.#texts.groupHeading(this.#agentName(), heading.dataset.time);
    }
  }

  /** The conversation so far, as `history` replays it: drawn at once, announced by no one. */
  replay(messages) {
    this.#clear();
    for (const message of messages) {
      const at = Number.isFinite(message.at) ? message.at : this.#now();
      if (message.role === "user") {
        // Received already; held if a wait is on and no reply came after it (5.1).
        this.#ownerBubble(`history:${this.#owner.size}`, message.text, at, { accepted: true });
      } else {
        this.#reply(this.#bubble("assistant", at), message, at);
      }
    }
  }

  /** One of the owner's messages, as it is sent. */
  owner({ id, text, queued = false }) {
    // A new message interrupts the turn in flight (ADR-0024); its reply won't come.
    this.stop("idle");
    let bubble;
    this.#flip(() => {
      bubble = this.#ownerBubble(id, text, this.#now(), { queued });
      enter(bubble.parentElement, { origin: "100% 100%" });
      this.#onChange({ kind: "owner", element: bubble });
    });
    const entry = this.#owner.get(id);
    entry.slowTimer = this.#timers.set(() => {
      entry.slow = true;
      this.#mark(entry);
    }, SENDING_AFTER_MS);
    return bubble;
  }

  #ownerBubble(id, text, at, { accepted = false, queued = false }) {
    const bubble = this.#bubble("user", at);
    bubble.dataset.id = id;
    bubble.append(textOf(text));
    const mark = document.createElement("p");
    mark.className = "mark";
    // The mark sits under the bubble, outside its fill, so its --muted text keeps its contrast.
    bubble.after(mark);
    const entry = { bubble, mark, accepted, refused: null, queued, slow: false, held: true };
    this.#owner.set(id, entry);
    this.#mark(entry);
    return bubble;
  }

  accept(id) {
    const entry = this.#owner.get(id);
    if (!entry || entry.accepted || entry.refused) return;
    entry.accepted = true;
    entry.queued = false;
    this.#timers.clear(entry.slowTimer);
    this.#mark(entry);
  }

  refuse(id, reason) {
    const entry = this.#owner.get(id);
    if (!entry || entry.accepted) return;
    entry.refused = reason;
    this.#timers.clear(entry.slowTimer);
    this.#mark(entry);
  }

  /** The wait before the reply holds the owner's latest messages (5.1). */
  setWaiting(waiting) {
    if (waiting === this.#waiting) return;
    this.#waiting = waiting;
    for (const entry of this.#owner.values()) this.#mark(entry);
  }

  #mark(entry) {
    const mark = markOf(entry, { waiting: this.#waiting });
    if (entry.shown === mark) return;
    entry.shown = mark;
    const { mark: element } = entry;
    // A queued message shows in --sunken until it goes out (5.12).
    entry.bubble.parentElement.toggleAttribute("data-queued", mark === "queued");
    if (mark === null) {
      // The mark fades out, as "held" does when the turn starts reading (5.1).
      const clear = () => {
        if (entry.shown !== null) return;
        element.dataset.mark = "";
        element.replaceChildren();
      };
      const fading = element.dataset.mark
        ? play(element, [{ opacity: 1 }, { opacity: 0 }], {
            duration: DUR.fade,
            easing: EASE.fade,
          })
        : null;
      if (fading) fading.finished.then(clear, clear);
      else clear();
      return;
    }
    element.dataset.mark = mark;
    const label =
      mark === "refused"
        ? (this.#texts.refused[entry.refused] ?? this.#texts.refused.other)
        : this.#texts[mark];
    element.replaceChildren(icon(mark === "refused" ? "alert" : "clock", "icon mark-icon"), label);
  }

  // ── A turn's activity ────────────────────────────────────────────────────────────────────────

  /** The wait is over, or the turn says what it does: the typing bubble shows (5.1). */
  working(step) {
    const activity = this.#ensureActivity();
    if (step === "tool") return;
    activity.phase = step;
    // Reading memory or thinking ends the tool before them; "typing" never wins over a tool.
    if (step !== "typing") this.#endStep();
    this.#tick();
  }

  /** A tool call starts (5.2): its row appears, or its label rolls to the new one. */
  tool(label) {
    const activity = this.#ensureActivity();
    const now = this.#now();
    const previous = activity.steps.at(-1);
    if (previous && previous.end === null) previous.end = now;
    activity.steps.push({ label, start: now, end: null });
    activity.phase = null;
    if (!activity.row) {
      activity.row = toolRow();
      this.#flip(() => {
        activity.bubble.parentElement.before(activity.row.element);
        activity.row.label.append(rollText(label));
        enter(activity.row.element, { spring: SPRINGS.fast });
        this.#onChange({ kind: "tool", element: activity.row.element });
      });
    } else {
      roll(activity.row.label, label);
      activity.row.element.dataset.state = "running";
    }
    this.#spin(activity.row);
    this.#tick();
  }

  /** Between tools, the model thinks: the running step ends. */
  #endStep() {
    const step = this.#activity?.steps.at(-1);
    if (step && step.end === null) step.end = this.#now();
  }

  /** A reply's bubble. It takes the typing bubble's place, in the same element (rule 6). */
  reply(frame) {
    const at = this.#now();
    const activity = this.#activity;
    let bubble;
    let before = null;
    if (activity) {
      bubble = activity.bubble;
      before = bubble.getBoundingClientRect();
      this.#finishActivity(null);
      bubble.classList.remove("typing");
      // The typing bubble was decoration; the reply is content screen readers reach.
      bubble.removeAttribute("aria-hidden");
      bubble.replaceChildren();
      this.#join(bubble, at);
    }
    const kind = Number.isSafeInteger(frame.confirmation) ? "approval" : "reply";
    if (before) {
      this.#reply(bubble, frame, at);
      resize(bubble, before);
      const content = bubble.querySelector(":scope > .text");
      if (content) fadeIn(content, REPLY_TEXT_DELAY);
      this.#onChange({ kind, element: bubble });
      return bubble;
    }
    // A new bubble: the ones above slide up as it arrives below them (5.1).
    this.#flip(() => {
      bubble = this.#bubble("assistant", at);
      this.#reply(bubble, frame, at);
      enter(bubble.parentElement, { origin: "0% 100%" });
      this.#onChange({ kind, element: bubble });
    });
    return bubble;
  }

  /**
   * The turn stopped: without a reply (`idle`), held by the owner's pause, or out of the page's
   * sight when the socket closed. A finished row stays as its summary.
   */
  stop(reason) {
    const activity = this.#activity;
    if (!activity) return;
    this.#finishActivity(reason === "paused" ? this.#texts.stoppedByPause : null);
    if (reason === "paused") {
      activity.bubble.classList.remove("typing");
      activity.bubble.removeAttribute("aria-hidden");
      activity.bubble.classList.add("stopped");
      activity.bubble.replaceChildren(textOf(this.#texts.stoppedByPause));
      this.#join(activity.bubble, this.#now());
      return;
    }
    const message = activity.bubble.parentElement;
    const group = message.parentElement;
    leave(message).then(() => this.#prune(group));
  }

  #ensureActivity() {
    if (this.#activity) return this.#activity;
    const bubble = document.createElement("div");
    bubble.className = "bubble typing";
    bubble.setAttribute("aria-hidden", "true");
    const dots = document.createElement("span");
    dots.className = "dots";
    for (let index = 0; index < 3; index += 1) dots.append(document.createElement("span"));
    const phase = document.createElement("span");
    phase.className = "phase";
    bubble.append(dots, phase);
    this.#activity = { bubble, phaseElement: phase, phase: null, steps: [], row: null };
    this.#activity.started = this.#now();
    this.#activity.ticker = this.#timers.every(() => this.#tick(), this.#less() ? 60_000 : 1_000);
    const activity = this.#activity;
    this.#flip(() => {
      place(this.#groupFor("assistant", this.#now()), messageOf("assistant", bubble));
      enter(bubble.parentElement, { origin: "0% 100%" });
      this.#onChange({ kind: "typing", element: bubble });
    });
    return activity;
  }

  /** The elapsed times: from 3 s, once a second, or once a minute under less motion (rule 8). */
  #tick() {
    const activity = this.#activity;
    if (!activity) return;
    const now = this.#now();
    const less = this.#less();
    const step = activity.steps.at(-1);
    if (activity.row && step && step.end === null) {
      activity.row.elapsed.textContent = elapsedText(now - step.start, this.#texts, { less }) ?? "";
    } else if (activity.row) {
      activity.row.elapsed.textContent = "";
    }
    const phase = activity.phase ? (this.#texts.steps[activity.phase] ?? "") : "";
    const elapsed = elapsedText(now - activity.started, this.#texts, { less });
    activity.phaseElement.textContent = phase && elapsed ? `${phase} · ${elapsed}` : phase;
  }

  /** The spinner shows only after 200 ms, turns at most 5 s, then a still ring stays (rule 8). */
  #spin(row) {
    this.#timers.clear(row.spinTimer);
    row.icon.dataset.state = "waiting";
    row.spinTimer = this.#timers.set(() => {
      row.icon.dataset.state = "spinning";
    }, SPINNER_AFTER_MS);
  }

  #finishActivity(note) {
    const activity = this.#activity;
    this.#activity = null;
    this.#timers.stop(activity.ticker);
    const { row, steps } = activity;
    if (!row) return;
    this.#timers.clear(row.spinTimer);
    const end = this.#now();
    for (const step of steps) step.end ??= end;
    const total = end - (steps[0]?.start ?? end);
    row.element.dataset.state = "done";
    row.icon.dataset.state = "done";
    row.icon.replaceChildren(icon(note ? "neutral" : "check"));
    roll(row.label, note ?? summaryText(steps.length, total, this.#texts));
    row.elapsed.textContent = "";
    row.head.disabled = false;
    row.list.replaceChildren(
      ...steps.map((step) => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = step.label;
        const time = document.createElement("span");
        time.className = "step-time";
        time.textContent = this.#texts.seconds(Math.round((step.end - step.start) / 100) / 10);
        item.append(label, time);
        return item;
      }),
    );
    row.head.addEventListener("click", () => openRow(row));
  }

  /**
   * Adds something below the latest messages, and they slide up from where they were (FLIP,
   * `--spring-base`, 5.1). `add` also tells the page, so the scroll that follows is measured too.
   */
  #flip(add) {
    const olds = this.#less()
      ? []
      : [...this.#root.querySelectorAll(".message, .tool-row")].slice(-FLIP_AT_MOST);
    const first = olds.map((element) => element.getBoundingClientRect().top);
    add();
    olds.forEach((element, index) => {
      if (!element.isConnected) return;
      const shift = first[index] - element.getBoundingClientRect().top;
      if (Math.abs(shift) < 0.5) return;
      play(element, [{ transform: `translateY(${shift}px)` }, { transform: "none" }], SPRINGS.base);
    });
  }

  // ── Days, groups and bubbles ─────────────────────────────────────────────────────────────────

  #clear() {
    for (const cards of this.#cards.values()) {
      for (const card of cards) this.#timers.clear(card.expiry);
    }
    if (this.#activity) this.#timers.stop(this.#activity.ticker);
    for (const entry of this.#owner.values()) this.#timers.clear(entry.slowTimer);
    this.#root.replaceChildren();
    this.#days.clear();
    this.#owner.clear();
    this.#cards.clear();
    this.#activity = null;
    this.#last = undefined;
  }

  /** A new bubble at the end of its group, which it opens if it doesn't join the last one. */
  #bubble(sender, at) {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.append(timeOf(at, this.#locale, "at"));
    const group = this.#groupFor(sender, at);
    place(group, messageOf(sender, bubble));
    this.#seen(sender, at, group);
    if (sender === "assistant") {
      // The owner's messages so far are read once a reply comes.
      for (const entry of this.#owner.values()) entry.held = false;
    }
    return bubble;
  }

  /** The typing bubble became a message: it now counts in its group, at `at`. */
  #join(bubble, at) {
    bubble.prepend(timeOf(at, this.#locale, "at"));
    this.#seen("assistant", at, bubble.parentElement.parentElement);
    for (const entry of this.#owner.values()) entry.held = false;
  }

  #seen(sender, at, group) {
    this.#last = { sender, at, group };
  }

  /**
   * The group a message at `at` joins: the last one when it is the same sender's, within 10
   * minutes, on the same day; otherwise a new one. The typing bubble takes the group its reply
   * will join, without counting as a message until it becomes one.
   */
  #groupFor(sender, at) {
    const day = this.#day(at);
    const last = this.#last;
    if (
      last?.group?.isConnected &&
      last.group.parentElement === day &&
      sameGroup(last, { sender, at })
    ) {
      return last.group;
    }
    const group = document.createElement("div");
    group.className = "group";
    group.dataset.sender = sender;
    const heading = document.createElement("h3");
    heading.className = "visually-hidden";
    heading.dataset.time = clock(at, this.#locale);
    heading.textContent = this.#texts.groupHeading(
      sender === "user" ? this.#texts.you : this.#agentName(),
      heading.dataset.time,
    );
    // No time under the group: each bubble's shows on hover or a tap (decision 1, #378).
    group.append(heading);
    day.append(group);
    // The typing bubble's group counts as the latest, so the next message from the owner opens
    // its own group after it.
    this.#last = { sender, at, group };
    return group;
  }

  #day(at) {
    const key = dayKey(at);
    const known = this.#days.get(key);
    if (known?.isConnected) return known;
    const section = document.createElement("section");
    section.className = "day";
    section.dataset.day = key;
    const heading = document.createElement("h2");
    heading.className = "day-label";
    const time = document.createElement("time");
    time.dateTime = key;
    time.textContent = dayLabel(at, this.#now(), this.#locale, this.#texts);
    heading.append(time);
    section.append(heading);
    this.#root.append(section);
    this.#days.set(key, section);
    return section;
  }

  /** A group left with no bubble goes, and its day with it. */
  #prune(group) {
    if (!group?.isConnected || group.querySelector(".message, .tool-row")) return;
    const day = group.parentElement;
    group.remove();
    if (day && !day.querySelector(".group")) day.remove();
  }

  /** What a reply shows: its blocks or its text, and a card for a confirmation's notice. */
  #reply(bubble, frame, at) {
    const content = document.createElement("div");
    content.className = "text";
    if (Array.isArray(frame.blocks)) content.append(renderBlocks(frame.blocks, this.#texts));
    else content.textContent = String(frame.text ?? "");
    if (frame.failed) {
      bubble.classList.add("failed");
      content.prepend(icon("alert"));
    }
    bubble.append(content);
    if (Number.isSafeInteger(frame.confirmation)) this.#card(bubble, frame.confirmation, at);
  }

  // ── The confirmation card (5.3) ──────────────────────────────────────────────────────────────

  #card(bubble, id, at) {
    const card = new Card(bubble, {
      id,
      until: at + CONFIRMATION_MS,
      who: this.#agentName(),
      texts: this.#texts,
      locale: this.#locale,
      onConfirm: this.#onConfirm,
      onPause: this.#onPause,
      mascot: this.#cardMascot,
      onAnnounce: this.#onAnnounce,
      onChange: this.#onChange,
      now: this.#now,
      timers: this.#timers,
    });
    if (!this.#cards.has(id)) this.#cards.set(id, []);
    this.#cards.get(id).push(card);
  }

  /**
   * The open confirmations the conversation lists (ADR-0052 §4). One with no card in the thread,
   * from a turn that settled before this socket opened, gets its card at the thread's end, with the
   * time it was asked; one with a card already gets no other.
   */
  requests(list) {
    for (const request of list) {
      if (this.#cards.has(request.id)) continue;
      const at = this.#now() - request.askedAgoMs;
      const bubble = this.#bubble("assistant", at);
      this.#reply(bubble, { text: request.summary, confirmation: request.id }, at);
      this.#onChange({ kind: "approval", element: bubble });
    }
  }

  /** What a press did, on every notice of that confirmation. */
  confirmation(id, status) {
    for (const card of this.#cards.get(id) ?? []) card.confirmation(status);
  }
}

/** A message: its bubble, and under it, for the owner's, its mark. */
function messageOf(sender, bubble) {
  const message = document.createElement("div");
  message.className = "message";
  message.dataset.sender = sender;
  message.append(bubble);
  return message;
}

function place(group, element) {
  group.append(element);
}

function textOf(text) {
  const content = document.createElement("div");
  content.className = "text";
  content.textContent = String(text ?? "");
  return content;
}

/** A bubble's exact time, shown on hover or a tap. */
function timeOf(at, locale, className) {
  const time = document.createElement("time");
  // The group's heading says the time to screen readers; these are for the eye.
  time.setAttribute("aria-hidden", "true");
  if (className) time.className = className;
  time.dateTime = new Date(at).toISOString();
  time.textContent = clock(at, locale);
  return time;
}

function toolRow() {
  const element = document.createElement("div");
  element.className = "tool-row";
  element.dataset.state = "running";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-head";
  head.disabled = true;
  head.setAttribute("aria-expanded", "false");
  const statusIcon = document.createElement("span");
  statusIcon.className = "tool-icon";
  statusIcon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "tool-label";
  const elapsed = document.createElement("span");
  elapsed.className = "tool-elapsed";
  head.append(statusIcon, label, elapsed);
  const list = document.createElement("ol");
  list.className = "tool-steps";
  list.hidden = true;
  element.append(head, list);
  return { element, head, icon: statusIcon, label, elapsed, list };
}

/** A finished row opens to its steps: height with `--spring-base`, steps `--stagger` apart. */
function openRow(row) {
  const open = row.list.hidden;
  row.head.setAttribute("aria-expanded", String(open));
  const before = row.element.getBoundingClientRect();
  row.list.hidden = !open;
  if (fromKeyboard() || reduced()) return;
  resize(row.element, before);
  if (!open) return;
  [...row.list.children].forEach((item, index) => {
    const delay = Math.min(index * STAGGER_MS, STAGGER_UNTIL_MS);
    play(
      item,
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: SPRINGS.base.duration, easing: SPRINGS.base.easing, delay, fill: "backwards" },
    );
  });
}
