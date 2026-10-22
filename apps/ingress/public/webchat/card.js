// The confirmation card (docs/design-system.md 5.3): who asks and until when, the notice, Confirm
// and the hold that pauses. The thread draws one on each notice, and a sidebar row draws one under
// itself for its agent's request (ADR-0052 §5). A VPS session's permission prompt draws one too,
// with Approve, Deny beside it, and no hold (ADR-0069 §1). Its content never changes in place: a
// press, an expiry or a refusal folds it into its receipt.

import { icon } from "./icons.js";
import { clock, SPINNER_AFTER_MS } from "./model.js";
import {
  DUR,
  EASE,
  fadeIn,
  fromKeyboard,
  play,
  reduced,
  resize,
  SCALE_IN_MOMENT,
  SPRINGS,
} from "./motion.js";
import { roll, rollText } from "./roll.js";

/** How long a confirmation's success shows before the card folds into its receipt (5.3). */
export const RING_MS = 650;
/** How long the card's hold must last to pause the conversation (ADR-0044 §2, the lab's hold). */
export const HOLD_MS = 1_200;
/** A press this soon after the card is drawn is ignored: the card may have appeared under it. */
export const PRESS_GUARD_MS = 400;

export const defaultTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
  every: (run, ms) => setInterval(run, ms),
  stop: (timer) => clearInterval(timer),
};

export class Card {
  /**
   * Makes `bubble`, which already holds the notice, a card for confirmation `id`. With `onDeny`,
   * Deny stands beside Confirm; without `onPause`, the card has no hold.
   *
   * @param {HTMLElement} bubble
   * @param {{
   *   id: number | string, until: number, who: string, texts: object, locale: string,
   *   onConfirm: (id: number | string) => boolean, onPause?: () => boolean,
   *   onDeny?: (id: number | string) => boolean,
   *   mascot?: (host: HTMLElement) => void, onAnnounce: (text: string) => void,
   *   onChange?: (change: { kind: string, element: Element, text: string }) => void,
   *   now?: () => number, timers?: typeof defaultTimers,
   * }} options
   */
  constructor(bubble, options) {
    this.id = options.id;
    this.bubble = bubble;
    this.open = true;
    this.pressed = false;
    this.viaKeyboard = false;
    this.texts = options.texts;
    this.locale = options.locale;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.onConfirm = options.onConfirm;
    this.onPause = options.onPause;
    this.onDeny = options.onDeny;
    this.onAnnounce = options.onAnnounce;
    this.onChange = options.onChange ?? (() => {});
    this.drawnAt = this.now();
    bubble.classList.add("card");
    // Who asks and until when, above the notice (the lab's "Aprovar uma ação", decision 13).
    const head = document.createElement("div");
    head.className = "card-head";
    const mascot = document.createElement("span");
    mascot.className = "card-mascot";
    mascot.setAttribute("aria-hidden", "true");
    const who = document.createElement("p");
    who.className = "card-who";
    who.textContent = this.texts.cardAsks(options.who);
    const until = document.createElement("p");
    until.className = "card-until";
    until.textContent = this.texts.cardUntil(clock(options.until, this.locale));
    const heading = document.createElement("div");
    heading.append(who, until);
    head.append(mascot, heading);
    bubble.prepend(head);
    options.mascot?.(mascot);
    this.actions = document.createElement("div");
    this.actions.className = "card-actions";
    this.confirm = document.createElement("button");
    this.confirm.type = "button";
    this.confirm.className = "confirm";
    this.confirm.dataset.confirmation = String(this.id);
    this.label = document.createElement("span");
    this.label.className = "label";
    this.label.append(rollText(this.texts.confirm));
    this.status = document.createElement("span");
    this.status.className = "confirm-icon";
    this.confirm.append(this.status, this.label);
    this.actions.append(this.confirm);
    if (this.onDeny) {
      // Deny, beside the primary button, outlined (5.3).
      this.deny = document.createElement("button");
      this.deny.type = "button";
      this.deny.className = "deny";
      this.denyLabel = document.createElement("span");
      this.denyLabel.className = "label";
      this.denyLabel.append(rollText(this.texts.deny));
      this.deny.append(this.denyLabel);
      this.actions.prepend(this.deny);
    }
    this.hold = this.onPause ? this.#hold() : null;
    bubble.append(this.actions, ...(this.hold ? [this.hold.button] : []));
    this.#pressable(
      this.confirm,
      () => this.onConfirm(this.id),
      (viaKey) => this.#press(viaKey),
    );
    if (this.deny) {
      this.#pressable(
        this.deny,
        () => this.onDeny(this.id),
        (viaKey) => this.#press(viaKey, this.deny, this.denyLabel, this.texts.denying),
      );
    }
    // A confirmation nobody answers expires after its 10 minutes (ADR-0026 §3).
    const left = options.until - this.now();
    if (left <= 0) {
      this.#fold("neutral", this.texts.expired, { announce: false, instant: true });
      return;
    }
    this.expiry = this.timers.set(() => {
      if (this.open && !this.pressed) this.#fold("neutral", this.texts.expired);
    }, left);
  }

  /**
   * A button that acts on a click, or on Enter or Space pressed on it: a key held down since before
   * the card appeared doesn't count, nor a press in the card's first 400 ms.
   */
  #pressable(button, ask, pressed) {
    let pressedHere = false;
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") pressedHere = !event.repeat;
    });
    button.addEventListener("click", (event) => {
      const viaKey = event.detail === 0;
      if (viaKey && !pressedHere) return;
      pressedHere = false;
      if (!this.open || this.pressed) return;
      if (this.now() - this.drawnAt < PRESS_GUARD_MS) return;
      if (!ask()) return;
      pressed(viaKey || fromKeyboard());
    });
  }

  /**
   * What the owner's verdict on a VPS session's prompt did: Approve's receipt once the session took
   * it, Deny's neutral one (5.3), or a neutral fold that says why it didn't count.
   */
  verdict(verdict, status, text) {
    if (!this.open) return;
    this.timers.clear(this.spin);
    this.timers.clear(this.expiry);
    if (status !== "applied") {
      this.#fold("neutral", text);
      return;
    }
    if (verdict === "allow") this.#succeed();
    else this.#fold("neutral", this.texts.deniedAt(clock(this.now(), this.locale)));
  }

  /** What a press did: the receipt, or a neutral fold when it wasn't open any more. */
  confirmation(status) {
    if (!this.open) return;
    this.timers.clear(this.spin);
    this.timers.clear(this.expiry);
    if (status !== "accepted") {
      this.#fold("neutral", this.texts.stale);
      return;
    }
    this.#succeed();
  }

  /** The card leaves the page with nothing to say, as a row's request closes. */
  dispose() {
    this.open = false;
    this.timers.clear(this.spin);
    this.timers.clear(this.expiry);
    this.timers.clear(this.hold?.timer);
  }

  /**
   * The card's hold, under its actions: held for 1.2 s, it pauses the conversation, as the
   * composer's Pause does (ADR-0044 §2). Holding, not clicking, keeps it from being a slip beside
   * Confirm. Its fill is progress, so it moves under reduced motion too (rule 10).
   */
  #hold() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hold";
    const fill = document.createElement("span");
    fill.className = "hold-fill";
    fill.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "label";
    label.append(rollText(this.texts.holdToPause));
    button.append(fill, label);
    const state = { button, timer: null, fill: null, done: false };
    const start = () => {
      if (state.done || state.timer !== null) return;
      roll(label, this.texts.holding);
      state.fill?.cancel();
      state.fill = play(fill, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
        duration: HOLD_MS,
        easing: "linear",
        fill: "forwards",
      });
      state.timer = this.timers.set(() => {
        state.timer = null;
        if (!this.onPause()) {
          end();
          return;
        }
        state.done = true;
        button.disabled = true;
        roll(label, this.texts.pausedStatus);
      }, HOLD_MS);
    };
    const end = () => {
      if (state.done) return;
      this.timers.clear(state.timer);
      state.timer = null;
      state.fill?.cancel();
      state.fill = null;
      roll(label, this.texts.holdToPause);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button > 0) return;
      event.preventDefault();
      start();
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
      button.addEventListener(type, end);
    }
    button.addEventListener("keydown", (event) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) {
        event.preventDefault();
        start();
      }
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") end();
    });
    button.addEventListener("contextmenu", (event) => event.preventDefault());
    return state;
  }

  /**
   * The press: the button grows to the card's width and says what it does, and the other one leaves
   * (5.3).
   */
  #press(viaKeyboard, button = this.confirm, label = this.label, working = this.texts.confirming) {
    this.pressed = true;
    this.viaKeyboard = viaKeyboard;
    const before = button.getBoundingClientRect();
    this.confirm.disabled = true;
    if (this.deny) this.deny.disabled = true;
    button.classList.add("pressed");
    this.bubble.dataset.state = "working";
    const other = button === this.confirm ? this.deny : this.confirm;
    if (other) {
      if (viaKeyboard || reduced()) other.hidden = true;
      else {
        const leaving = play(
          other,
          [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: `scale(${SCALE_IN_MOMENT})` },
          ],
          { duration: DUR.exitMoment, easing: EASE.exit, fill: "forwards" },
        );
        const gone = () => {
          other.hidden = true;
        };
        if (leaving) leaving.finished.then(gone, gone);
        else gone();
      }
    }
    if (!viaKeyboard) resize(button, before, SPRINGS.moment);
    roll(label, working);
    if (button !== this.confirm) return;
    this.status.dataset.state = "waiting";
    this.spin = this.timers.set(() => {
      this.status.dataset.state = "spinning";
    }, SPINNER_AFTER_MS);
  }

  #succeed() {
    this.open = false;
    this.bubble.dataset.state = "done";
    this.status.dataset.state = "done";
    this.status.replaceChildren(icon("check", "icon draw"));
    const quiet = this.viaKeyboard || reduced();
    if (!quiet) {
      play(this.confirm, [{ transform: "scale(1.03)" }, { transform: "scale(1)" }], SPRINGS.pop);
      const ring = document.createElement("span");
      ring.className = "ring";
      ring.setAttribute("aria-hidden", "true");
      this.confirm.append(ring);
      play(
        ring,
        [
          { opacity: 0.7, transform: "scale(1)" },
          { opacity: 0, transform: "scale(1.5)" },
        ],
        { duration: RING_MS, easing: EASE.fade, fill: "forwards" },
      );
    }
    const receipt = this.texts.confirmedAt(clock(this.now(), this.locale));
    this.timers.set(() => this.#fold("check", receipt), quiet ? DUR.fade : RING_MS);
  }

  /**
   * The card folds into its receipt, who decided what and when (5.3): its content leaves first
   * (exit), then its height goes to the receipt's with `--spring-moment`.
   */
  #fold(glyph, text, { announce = true, instant = false } = {}) {
    this.open = false;
    this.timers.clear(this.hold?.timer);
    const { bubble } = this;
    bubble.dataset.state = glyph === "check" ? "confirmed" : "closed";
    const content = [...bubble.children].filter((child) => !child.matches("time.at"));
    const swap = () => {
      if (!bubble.isConnected && !instant) return;
      const before = bubble.getBoundingClientRect();
      const receipt = document.createElement("p");
      receipt.className = "receipt";
      receipt.append(icon(glyph), text);
      for (const child of content) child.remove();
      bubble.append(receipt);
      bubble.classList.add("receipt-only");
      if (!instant) {
        resize(bubble, before, SPRINGS.moment);
        if (reduced()) fadeIn(receipt);
        else
          play(
            receipt,
            [
              { opacity: 0, transform: "translateY(4px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: SPRINGS.moment.duration, easing: SPRINGS.moment.easing, delay: 60 },
          );
      }
      if (announce) this.onAnnounce(text);
      this.onChange({ kind: "receipt", element: bubble, text });
    };
    if (instant || this.viaKeyboard || reduced()) {
      swap();
      return;
    }
    const leaving = content
      .map((child) =>
        play(child, [{ opacity: 1 }, { opacity: 0 }], {
          duration: DUR.exitMoment,
          easing: EASE.exit,
          fill: "forwards",
        }),
      )
      .filter(Boolean);
    if (leaving.length === 0) {
      swap();
      return;
    }
    Promise.all(leaving.map((animation) => animation.finished)).then(swap, swap);
  }
}
