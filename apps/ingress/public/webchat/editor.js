// The agent's editor (#379, docs/design-system.md 5.25): opened from the pencil on an agent's
// mascot, a panel beside the sidebar on a wide screen and a 90% sheet on the phone. Its sections
// sit on the left: Profile and Mascot now, the agent's own files with #381. Everything changes
// here first, and one Save writes it: the mascot whole, and the profile's changed fields, each
// through its owner-only route. The conversation stays behind it, still live.

import { Construtor, PREVIEW_PX, SHEET_PREVIEW_PX } from "./construtor.js";
import {
  changedSections,
  cleanLine,
  LIMITS,
  profileChanges,
  profileOf,
  profileValid,
  SAVED_SECTIONS,
  SECTIONS,
} from "./editor-model.js";
import { icon, outline } from "./icons.js";
import { Mascot, ownerTyping } from "./mascot.js";
import { APPROVED_MS } from "./mascot-states.js";
import { loginState, SPINNER_AFTER_MS } from "./model.js";
import { DUR, EASE, enter, fadeIn, fromKeyboard, play, reduced, SPRINGS } from "./motion.js";
import { roll, rollText } from "./roll.js";
import { tips } from "./tips.js";

/** The agent's mascot beside its name, on the left. */
export const ID_PX = 56;
/** Siblings leave and enter this far apart (`--stagger`). */
export const STAGGER_MS = 30;

const element = (tag, className) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  return made;
};
const isField = (target) =>
  target instanceof Element && Boolean(target.closest("input, textarea, [contenteditable]"));

/** What a save's route answers: the values the agent now shows, or why not. */
async function put(agentId, section, body) {
  try {
    const response = await fetch(`/webchat/agents/${encodeURIComponent(agentId)}/${section}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body),
      redirect: "manual",
      cache: "no-store",
    });
    // Access answers an expired login with 401, or a redirect to its sign-in (5.12).
    if (loginState(response) === "expired") return { ok: false, status: 401 };
    if (!response.ok) {
      // A profile that failed after some of its fields were set names them.
      const body = await response.json().catch(() => null);
      return { ok: false, status: response.status, ...(body?.saved ? { value: body.saved } : {}) };
    }
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

export class Editor {
  #names;
  #toasts;
  #onSaved;
  #onClose;
  #onExpired;
  #send;
  #timers;
  /** The editor that is open: its agent, what is saved, what the owner changed, and its parts. */
  #open = null;

  /**
   * @param {{
   *   texts: object, toasts: { show: Function },
   *   onSaved: (agentId: string, changes: object) => void,
   *   onClose?: (agentId: string) => void, onExpired?: () => void,
   *   send?: typeof put, timers?: { set: Function, clear: Function },
   * }} options
   */
  constructor({ texts, toasts, onSaved, onClose = () => {}, onExpired = () => {}, send, timers }) {
    this.#names = texts.editor;
    this.#toasts = toasts;
    this.#onSaved = onSaved;
    this.#onClose = onClose;
    this.#onExpired = onExpired;
    this.#send = send ?? put;
    this.#timers = timers ?? {
      set: (run, ms) => setTimeout(run, ms),
      clear: (timer) => clearTimeout(timer),
    };
    // A phone's Back closes the sheet, asking first when something changed (NN/g's sheet rules).
    addEventListener("popstate", () => {
      const open = this.#open;
      if (!open?.sheet || open.closing) return;
      open.pushed = false;
      if (this.#changed().length > 0) {
        history.pushState({ editor: open.agent.id }, "");
        open.pushed = true;
        this.#ask();
        return;
      }
      this.close();
    });
  }

  /** The agent whose editor is open, or null. */
  get agentId() {
    return this.#open?.agent.id ?? null;
  }

  /**
   * Opens the agent's editor, on its Mascot section. From a click it grows from the row, and the
   * row's mascot flies into the preview; from the keyboard it appears at once.
   *
   * @param {{ id: string, name: string, main: boolean, mascot: object, specialty?: string,
   *   remit?: string }} agent
   * @param {{ trigger: HTMLElement, from?: HTMLElement | null, keyboard?: boolean,
   *   sheet?: boolean, returnTo?: HTMLElement }} how `returnTo` takes focus back when the
   *   trigger is hidden by then, as the phone's switcher is.
   * @returns {boolean} whether it opened: another agent's editor with changes asks first.
   */
  open(agent, { trigger, from = null, keyboard = false, sheet = false, returnTo = trigger }) {
    if (this.#open) {
      // A save on its way finishes in the editor that sent it.
      if (this.#open.saving) return false;
      if (this.#changed().length > 0) {
        this.#ask();
        return false;
      }
      this.close({ force: true, instant: true });
    }
    const saved = { profile: profileOf(agent), mascot: agent.mascot };
    const open = {
      agent,
      trigger,
      returnTo,
      sheet,
      saved,
      draft: { profile: { ...saved.profile }, mascot: saved.mascot },
      section: "mascot",
      footer: "edit",
      failed: new Set(),
      saving: false,
      closeWhenSaved: false,
      closing: false,
      pushed: false,
      closeTimer: null,
      toast: null,
    };
    this.#open = open;
    this.#build(open);
    trigger?.setAttribute("aria-expanded", "true");
    document.body.append(open.root);
    if (sheet) {
      open.scrim = element("div", "editor-scrim");
      open.scrim.addEventListener("click", () => this.close());
      open.root.before(open.scrim);
      // The sheet covers the page: what is behind it can't take focus or a press.
      for (const behind of document.querySelectorAll(".app")) behind.inert = true;
      history.pushState({ editor: agent.id }, "");
      open.pushed = true;
    }
    open.idMascot = new Mascot(open.idHost, {
      mascot: agent.mascot,
      px: ID_PX,
      mode: "large",
      quietable: true,
    });
    this.#select(open.section, { instant: true });
    this.#renderFooter();
    tips(open.root);
    open.tabs.get(open.section).focus({ preventScroll: true });
    if (keyboard || fromKeyboard()) return true;
    if (reduced()) {
      fadeIn(open.root);
      return true;
    }
    if (sheet) {
      play(open.root, [{ transform: "translateY(100%)" }, { transform: "none" }], SPRINGS.slow);
      return true;
    }
    this.#grow(open, from);
    return true;
  }

  /**
   * Closes it. With changes it asks first, inside the panel, unless `force`. Leaving takes
   * --dur-exit, and focus goes back to the pencil that opened it.
   */
  close({ force = false, instant = false } = {}) {
    const open = this.#open;
    if (!open || open.closing) return;
    // A save on its way closes the editor once it ends, with its toast.
    if (open.saving) {
      open.closeWhenSaved = true;
      return;
    }
    if (!force && this.#changed().length > 0) {
      this.#ask();
      return;
    }
    open.closing = true;
    this.#timers.clear(open.closeTimer);
    this.#open = null;
    // Leaving, it is no longer the editor the pencils control, nor something to press.
    open.root.removeAttribute("id");
    open.root.inert = true;
    open.trigger?.setAttribute("aria-expanded", "false");
    for (const behind of document.querySelectorAll(".app")) behind.inert = false;
    if (open.pushed) history.back();
    const back =
      open.trigger?.isConnected && !open.trigger.closest("[hidden]") ? open.trigger : open.returnTo;
    back?.focus({ preventScroll: true });
    this.#onClose(open.agent.id);
    // A save that ended, closed within its Approved moment or after: its toast and its Undo.
    if (open.toast) this.#toast(open.toast);
    const gone = () => {
      open.root.remove();
      open.scrim?.remove();
    };
    if (instant) {
      gone();
      return;
    }
    const leaving = play(
      open.root,
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: open.sheet ? "translateY(8px)" : "scale(.98)" },
      ],
      { duration: DUR.exit, easing: EASE.exit, fill: "forwards" },
    );
    if (open.scrim) {
      play(open.scrim, [{ opacity: 1 }, { opacity: 0 }], {
        duration: DUR.exit,
        easing: EASE.exit,
        fill: "forwards",
      });
    }
    if (leaving) leaving.finished.then(gone, gone);
    else gone();
  }

  // ── The frame ───────────────────────────────────────────────────────────────────────────────

  #build(open) {
    const names = this.#names;
    const { agent } = open;
    const root = element("section", open.sheet ? "editor sheet" : "editor");
    root.id = "editor";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", names.edit(agent.name));
    if (open.sheet) root.setAttribute("aria-modal", "true");
    open.root = root;

    // The agent, on the left: its mascot, its name and its specialty.
    const id = element("div", "editor-id");
    open.idHost = element("span", "mascot-host");
    open.idHost.setAttribute("aria-hidden", "true");
    const who = element("div", "editor-who");
    open.nameLine = element("b", "editor-name");
    open.specialtyLine = element("span", "editor-specialty");
    who.append(open.nameLine, open.specialtyLine);
    id.append(open.idHost, who);

    // The sections (APG tabs): the highlight slides with --spring-fast.
    const tablist = element("div", "editor-tabs");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", names.sectionsOf(agent.name));
    open.highlight = element("span", "editor-hl");
    open.highlight.setAttribute("aria-hidden", "true");
    tablist.append(open.highlight);
    open.tabs = new Map();
    for (const section of SECTIONS) {
      const tab = element("button", "navi");
      tab.type = "button";
      tab.id = `editor-tab-${section.id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "editor-panel");
      tab.dataset.section = section.id;
      const label = element("span", "nl");
      label.textContent = names.sections[section.id];
      tab.append(section.icon === "body" ? outline("body") : icon(section.icon), label);
      if (section.ready) {
        tab.addEventListener("click", () => this.#select(section.id));
      } else {
        // The agent's own files are #381's: shown, so the frame doesn't change when they arrive.
        tab.setAttribute("aria-disabled", "true");
        const soon = element("span", "soon");
        soon.textContent = names.soon;
        tab.append(soon);
      }
      const mark = element("span", "mark-dot");
      mark.setAttribute("aria-hidden", "true");
      tab.append(mark);
      open.tabs.set(section.id, tab);
      tablist.append(tab);
    }
    tablist.addEventListener("keydown", (event) => this.#tabKey(event));

    const head = element("header", "editor-head");
    open.title = element("h2", "editor-title");
    const close = element("button", "icb close");
    close.type = "button";
    close.setAttribute("aria-label", names.close);
    close.dataset.tip = "";
    close.append(icon("close"));
    close.addEventListener("click", () => this.close());
    head.append(open.title, close);

    open.body = element("div", "editor-body");
    open.body.id = "editor-panel";
    open.body.setAttribute("role", "tabpanel");

    open.foot = element("footer", "editor-foot");
    // The grid, inside the panel: while the panel grows, it keeps its final size (5.25).
    open.frame = element("div", "editor-in");
    open.frame.append(id, tablist, head, open.body, open.foot);
    root.append(open.frame);

    open.profile = this.#profile(open);
    open.construtor = new Construtor({
      names,
      look: open.draft.mascot,
      previewPx: open.sheet ? SHEET_PREVIEW_PX : PREVIEW_PX,
      onChange: (look) => {
        open.draft.mascot = look;
        // The agent on the left follows too, with a crossfade only: the preview carries the motion.
        open.idMascot?.restyle(look, "color");
        this.#edited();
      },
    });
    // Both sections stay on the page, so the preview's mascot stays alive while Profile shows.
    open.body.append(open.profile.element, open.construtor.element);
    this.#identity();

    root.addEventListener("keydown", (event) => this.#key(event));
  }

  /** The name and specialty on the left follow what the owner writes. */
  #identity() {
    const open = this.#open;
    const { draft, agent } = open;
    open.nameLine.textContent = draft.profile.name.trim() || agent.name;
    open.specialtyLine.textContent = agent.main
      ? this.#names.principal
      : draft.profile.specialty.trim();
  }

  /** Shows a section: its content rises with --rise and --spring-base, and the mascot acts it out. */
  #select(section, { instant = false } = {}) {
    const open = this.#open;
    const previous = open.body.dataset.section;
    open.section = section;
    for (const [id, tab] of open.tabs) {
      tab.setAttribute("aria-selected", String(id === section));
      tab.tabIndex = id === section ? 0 : -1;
    }
    open.body.setAttribute("aria-labelledby", `editor-tab-${section}`);
    open.title.textContent = this.#names.sections[section];
    const content = section === "profile" ? open.profile.element : open.construtor.element;
    open.body.dataset.section = section;
    open.profile.element.hidden = content !== open.profile.element;
    open.construtor.element.hidden = content !== open.construtor.element;
    if (section === "mascot") open.construtor.mount();
    this.#placeHighlight(instant || previous === undefined);
    this.#renderFooter();
    const quiet = instant || fromKeyboard();
    if (previous !== undefined && previous !== section && !quiet) enter(content);
    // The mascot acts out the section (5.19's poses): it looks at the owner in Profile.
    if (section === "profile") open.idMascot?.lookYou(1800);
    else open.idMascot?.blink();
  }

  #placeHighlight(instant) {
    const open = this.#open;
    const tab = open.tabs.get(open.section);
    const to = { x: tab.offsetLeft, y: tab.offsetTop, w: tab.offsetWidth, h: tab.offsetHeight };
    const { highlight } = open;
    const from = open.highlightAt;
    highlight.style.transform = `translate(${to.x}px, ${to.y}px)`;
    highlight.style.inlineSize = `${to.w}px`;
    highlight.style.blockSize = `${to.h}px`;
    open.highlightAt = to;
    if (instant || !from || fromKeyboard() || reduced()) return;
    play(
      highlight,
      [
        { transform: `translate(${from.x}px, ${from.y}px)` },
        { transform: `translate(${to.x}px, ${to.y}px)` },
      ],
      SPRINGS.fast,
    );
  }

  #tabKey(event) {
    const open = this.#open;
    const order = SECTIONS.filter((section) => section.ready).map((section) => section.id);
    const index = order.indexOf(document.activeElement?.dataset?.section);
    if (index === -1) return;
    const step = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    }[event.key];
    const to =
      step !== undefined
        ? (index + step + order.length) % order.length
        : { Home: 0, End: order.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    this.#select(order[to]);
    open.tabs.get(order[to]).focus();
  }

  /**
   * The keys the editor answers wherever focus is in it: Escape closes, or keeps editing while it
   * asks; ⌘S saves; ⌘Z undoes the mascot's last step, outside a text field, which keeps its own.
   */
  #key(event) {
    const open = this.#open;
    if (!open) return;
    const command = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      if (open.footer === "ask") this.#keepEditing();
      else this.close();
      return;
    }
    if (command && event.key.toLowerCase() === "s") {
      event.preventDefault();
      this.save({ keyboard: true });
      return;
    }
    if (command && !event.shiftKey && event.key.toLowerCase() === "z" && !isField(event.target)) {
      event.preventDefault();
      open.construtor.undo();
    }
  }

  // ── The grow, from the row (5.25) ───────────────────────────────────────────────────────────

  /**
   * The panel grows from the row with --spring-slow, its content laid out at its final size and
   * fading in once the panel can hold it. A copy of the row's mascot flies out and grows into the
   * preview, 5.14's shared element.
   */
  #grow(open, from) {
    const { root } = open;
    const end = root.getBoundingClientRect();
    const start = from?.getBoundingClientRect();
    const preview = open.construtor.host.getBoundingClientRect();
    if (!start || end.width === 0) {
      play(
        root,
        [
          { opacity: 0, transform: "scale(.97)" },
          { opacity: 1, transform: "none" },
        ],
        SPRINGS.slow,
      );
      return;
    }
    const frame = { width: `${end.width}px`, height: `${end.height}px` };
    const grown = play(
      root,
      [
        {
          left: `${start.left}px`,
          top: `${start.top}px`,
          width: `${start.width}px`,
          height: `${start.height}px`,
          borderRadius: "10px",
        },
        {
          left: `${end.left}px`,
          top: `${end.top}px`,
          width: frame.width,
          height: frame.height,
        },
      ],
      SPRINGS.slow,
    );
    // Laid out at its final size, the content doesn't reflow while the panel grows.
    root.classList.add("growing");
    root.style.setProperty("--grown-w", frame.width);
    root.style.setProperty("--grown-h", frame.height);
    const settled = () => root.classList.remove("growing");
    if (grown) grown.finished.then(settled, settled);
    else settled();
    [...open.frame.children].forEach((child, index) => {
      play(
        child,
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: SPRINGS.base.duration,
          easing: SPRINGS.base.easing,
          delay: SPRINGS.slow.duration * 0.35 + Math.min(index * STAGGER_MS, 300),
          fill: "backwards",
        },
      );
    });
    this.#fly(open, from, preview);
  }

  /** `b` is the preview's place once the panel has grown, measured before it starts. */
  #fly(open, from, b) {
    const source = from.querySelector(".mascot-host");
    const target = open.construtor.host;
    if (!source || !target.isConnected) return;
    const a = source.getBoundingClientRect();
    if (a.width === 0 || b.width === 0) return;
    const flier = element("span", "mascot-host flier");
    flier.setAttribute("aria-hidden", "true");
    Object.assign(flier.style, {
      left: `${b.left}px`,
      top: `${b.top}px`,
      width: `${b.width}px`,
      height: `${b.height}px`,
    });
    document.body.append(flier);
    new Mascot(flier, { mascot: open.saved.mascot, px: b.width, mode: "still" });
    target.style.visibility = "hidden";
    const scale = a.width / b.width;
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    const landed = () => {
      flier.remove();
      target.style.visibility = "";
      open.construtor.preview?.lookYou(1400);
    };
    const flight = play(
      flier,
      [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: "none" }],
      { ...SPRINGS.slow, fill: "both" },
    );
    if (flight) flight.finished.then(landed, landed);
    else landed();
  }

  // ── Profile ─────────────────────────────────────────────────────────────────────────────────

  /** Its name, its specialty and its short description; the main agent's specialty is locked. */
  #profile(open) {
    const names = this.#names;
    const wrap = element("div", "flds");
    const fields = {};
    const field = (key, label, { help, locked = false } = {}) => {
      const box = element("div", "fld");
      const input = element("input", locked ? "inp locked" : "inp");
      input.id = `editor-${key}`;
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = key !== "name";
      input.maxLength = LIMITS[key];
      const name = element("label");
      name.htmlFor = input.id;
      name.textContent = label;
      const row = element("div", locked ? "inp-row locked" : "inp-row");
      if (locked) {
        input.readOnly = true;
        input.value = names.principal;
        row.append(icon("lock"), input);
      } else {
        input.value = open.draft.profile[key];
        row.append(input);
      }
      box.append(name, row);
      const below = element("div", "help");
      const words = element("span");
      words.id = `${input.id}-help`;
      words.textContent = help ?? "";
      below.append(words);
      if (!locked && key !== "name") {
        const count = element("span", "count");
        below.append(count);
        fields[`${key}Count`] = count;
      }
      if (help) input.setAttribute("aria-describedby", words.id);
      box.append(below);
      if (!locked) {
        input.addEventListener("input", () => {
          // What the line can't hold goes, as a paste often brings it.
          const clean = cleanLine(input.value);
          if (clean !== input.value) {
            const caret = (input.selectionStart ?? input.value.length) - input.value.length;
            input.value = clean;
            const at = Math.max(0, clean.length + caret);
            input.setSelectionRange?.(at, at);
          }
          open.draft.profile[key] = input.value;
          // Reading comes first: while the owner types, the mascot only breathes and blinks.
          ownerTyping();
          this.#edited();
        });
      }
      fields[key] = input;
      wrap.append(box);
      return box;
    };
    field("name", names.name);
    const error = element("p", "field-error");
    error.id = "editor-name-error";
    error.hidden = true;
    error.append(icon("alert"), names.nameEmpty);
    wrap.firstElementChild.append(error);
    field("specialty", names.specialty, {
      help: open.agent.main ? names.specialtyLocked : names.specialtyHelp,
      locked: open.agent.main,
    });
    field("remit", names.remit, { help: names.remitHelp });
    const profile = { element: wrap, fields, error };
    this.#counts(profile, open.draft.profile);
    return profile;
  }

  /** "15 of 40": how much of each field's line is used, in Geist Mono. */
  #counts(profile, draft) {
    for (const key of ["specialty", "remit"]) {
      const count = profile.fields[`${key}Count`];
      if (count) count.textContent = this.#names.count(draft[key].length, LIMITS[key]);
    }
  }

  // ── What changed ────────────────────────────────────────────────────────────────────────────

  #changed() {
    const open = this.#open;
    if (!open) return [];
    return changedSections({ saved: open.saved, draft: open.draft, main: open.agent.main });
  }

  /** Something changed: the marks, the identity and the footer follow, and an ask goes. */
  #edited() {
    const open = this.#open;
    // A change after a save keeps the panel open, and its button says Save again.
    this.#timers.clear(open.closeTimer);
    if (open.save?.dataset.state === "done") {
      this.#resetSave(open);
      open.toast = null;
    }
    // A failed section the owner took back to what is saved has nothing left to save.
    const changed = new Set(this.#changed());
    for (const id of [...open.failed]) if (!changed.has(id)) open.failed.delete(id);
    if (open.footer !== "edit" && !open.saving) {
      this.#plainFooter();
      open.footer = "edit";
    }
    this.#counts(open.profile, open.draft.profile);
    const valid = profileValid(open.draft.profile);
    open.profile.error.hidden = valid;
    open.profile.fields.name.setAttribute("aria-invalid", String(!valid));
    if (valid) open.profile.fields.name.removeAttribute("aria-errormessage");
    else open.profile.fields.name.setAttribute("aria-errormessage", open.profile.error.id);
    this.#identity();
    this.#marks();
    this.#renderFooter();
  }

  /**
   * A changed section shows a 6 px `--accent` dot, which enters from 0.6 with --spring-fast, and
   * its tab's name adds "changed"; one whose save failed shows `--danger` until it saves.
   */
  #marks({ leaving = false } = {}) {
    const open = this.#open;
    const changed = new Set(this.#changed());
    let order = 0;
    for (const id of SAVED_SECTIONS) {
      const tab = open.tabs.get(id);
      const dot = tab.querySelector(".mark-dot");
      const state = open.failed.has(id) ? "failed" : changed.has(id) ? "changed" : "";
      const before = dot.dataset.state ?? "";
      const label = this.#names.sections[id];
      tab.setAttribute(
        "aria-label",
        state === "failed"
          ? `${label}, ${this.#names.notSaved}`
          : state === "changed"
            ? `${label}, ${this.#names.changed}`
            : label,
      );
      if (state === before) continue;
      if (state === "") {
        delete dot.dataset.state;
        if (leaving && !reduced()) {
          play(
            dot,
            [
              { opacity: 1, transform: "none" },
              { opacity: 0, transform: "scale(.6)" },
            ],
            { duration: DUR.exit, easing: EASE.exit, delay: order * STAGGER_MS },
          );
          order += 1;
        }
        continue;
      }
      dot.dataset.state = state;
      dot.replaceChildren(...(state === "failed" ? [icon("alert")] : []));
      if (!fromKeyboard() && !reduced()) {
        play(
          dot,
          [
            { opacity: 0, transform: "scale(.6)" },
            { opacity: 1, transform: "none" },
          ],
          SPRINGS.fast,
        );
      }
    }
  }

  // ── The footer: one Save, and the two ways a save can end early ─────────────────────────────

  #renderFooter() {
    const open = this.#open;
    if (!open) return;
    const names = this.#names;
    const { foot } = open;
    const changed = this.#changed();
    if (open.footer !== "edit") return;
    if (!foot.querySelector(".save")) {
      foot.replaceChildren();
      foot.className = "editor-foot";
      open.dirty = element("p", "dirty");
      open.dirty.setAttribute("role", "status");
      const cancel = element("button", "btn ghost cancel");
      cancel.type = "button";
      cancel.textContent = names.cancel;
      cancel.addEventListener("click", () => this.close());
      open.save = element("button", "btn primary save");
      open.save.type = "button";
      open.save.setAttribute("aria-keyshortcuts", "Meta+S Control+S");
      open.saveIcon = element("span", "confirm-icon");
      const stem = element("span", "stem");
      stem.textContent = names.save.stem;
      open.saveSuffix = element("span", "suffix");
      open.saveSuffix.append(rollText(names.save.idle));
      const word = element("span", "word");
      word.append(stem, open.saveSuffix);
      open.save.append(open.saveIcon, word);
      open.save.addEventListener("click", (event) =>
        this.save({ keyboard: event.detail === 0 || fromKeyboard() }),
      );
      open.meta = element("p", "meta");
      foot.append(open.dirty, cancel, open.save, open.meta);
    }
    if (!open.saving && open.save.dataset.state !== "done") {
      open.save.setAttribute(
        "aria-disabled",
        String(changed.length === 0 || !profileValid(open.draft.profile)),
      );
    }
    const count = changed.length;
    if (count === 0) {
      open.dirty.replaceChildren(names.allSaved);
    } else {
      const dot = element("i");
      dot.setAttribute("aria-hidden", "true");
      // The count in Geist Mono, inside one line of words.
      const words = element("span");
      const digits = element("span", "digits");
      const text = names.unsaved(count);
      const at = text.indexOf(String(count));
      digits.textContent = String(count);
      words.append(text.slice(0, at), digits, text.slice(at + String(count).length));
      open.dirty.replaceChildren(dot, words);
    }
    open.meta.textContent = open.section === "mascot" ? names.photoNote(open.agent.name) : "";
    open.meta.hidden = open.section !== "mascot";
  }

  /** Closing with changes asks inside the panel, never in a dialog over it. */
  #ask() {
    const open = this.#open;
    const names = this.#names;
    const changed = this.#changed();
    open.footer = "ask";
    const { foot } = open;
    foot.className = "editor-foot discard";
    foot.replaceChildren();
    foot.setAttribute("role", "alertdialog");
    foot.setAttribute("aria-labelledby", "editor-ask");
    foot.setAttribute("aria-describedby", "editor-ask-what");
    const text = element("p");
    const title = element("b");
    title.id = "editor-ask";
    title.textContent = names.discardAsk(changed.length);
    const what = element("span");
    what.id = "editor-ask-what";
    what.textContent = names.discardWhat(changed.map((id) => names.sections[id]));
    text.append(title, what);
    const keep = element("button", "btn ghost");
    keep.type = "button";
    keep.textContent = names.keepEditing;
    keep.addEventListener("click", () => this.#keepEditing());
    const discard = element("button", "btn danger");
    discard.type = "button";
    discard.textContent = names.discard;
    discard.addEventListener("click", () => this.close({ force: true }));
    foot.append(icon("alert"), text, keep, discard);
    if (!fromKeyboard() && !reduced()) enter(foot, { spring: SPRINGS.fast, rise: 4 });
    keep.focus();
  }

  #keepEditing() {
    const open = this.#open;
    this.#plainFooter();
    open.footer = "edit";
    this.#renderFooter();
    open.save.focus();
  }

  #plainFooter() {
    const { foot } = this.#open;
    foot.className = "editor-foot";
    foot.removeAttribute("role");
    foot.removeAttribute("aria-labelledby");
    foot.removeAttribute("aria-describedby");
    foot.replaceChildren();
  }

  /**
   * Saves every changed section once: the mascot whole, the profile's changed fields. The button
   * says what it does, Sav-e, Sav-ing, Sav-ed; success is 5.3 without its ring, which stays the
   * owner's yes. Then the panel closes, and a toast offers Undo for 10 s.
   */
  async save({ keyboard = false } = {}) {
    const open = this.#open;
    if (!open || open.saving) return;
    const sections = this.#changed();
    if (sections.length === 0) return;
    if (!profileValid(open.draft.profile)) {
      this.#select("profile");
      open.profile.fields.name.focus();
      return;
    }
    open.saving = true;
    if (open.footer !== "edit") {
      this.#plainFooter();
      open.footer = "edit";
      this.#renderFooter();
    }
    const { save } = open;
    save.setAttribute("aria-disabled", "true");
    save.dataset.state = "working";
    roll(open.saveSuffix, this.#names.save.busy);
    open.saveIcon.dataset.state = "waiting";
    const spin = this.#timers.set(() => {
      open.saveIcon.dataset.state = "spinning";
    }, SPINNER_AFTER_MS);
    const before = { profile: { ...open.saved.profile }, mascot: open.saved.mascot };
    const bodies = {
      profile: profileChanges(open.saved.profile, open.draft.profile, { main: open.agent.main }),
      mascot: open.draft.mascot,
    };
    const results = await Promise.all(
      sections.map(async (section) => ({
        section,
        ...(await this.#send(open.agent.id, section, bodies[section])),
      })),
    );
    this.#timers.clear(spin);
    open.saving = false;
    const changes = {};
    for (const result of results) {
      if (result.ok) open.failed.delete(result.section);
      // A profile that failed part of the way says what it set before.
      if (!result.value) continue;
      if (result.section === "mascot") {
        open.saved.mascot = result.value.mascot;
        changes.mascot = result.value.mascot;
      } else {
        open.saved.profile = { ...open.saved.profile, ...result.value };
        Object.assign(changes, result.value);
      }
    }
    if (Object.keys(changes).length > 0) this.#onSaved(open.agent.id, changes);
    const failed = results.filter((result) => !result.ok);
    if (failed.some((result) => result.status === 401)) this.#onExpired();
    if (this.#open !== open) return;
    if (failed.length > 0) {
      open.closeWhenSaved = false;
      for (const result of failed) open.failed.add(result.section);
      this.#failed(
        failed.map((result) => result.section),
        results.filter((result) => result.ok).map((result) => result.section),
      );
      return;
    }
    // Undo sends back what was saved before each changed field, and the mascot whole.
    const undo = {
      mascot: before.mascot,
      profile: Object.fromEntries(
        Object.keys(bodies.profile).map((key) => [key, before.profile[key]]),
      ),
    };
    // What the owner changed while it saved is still to save: the editor stays, and says so.
    if (this.#changed().length > 0) {
      this.#marks({ leaving: true });
      this.#resetSave(open);
      if (open.closeWhenSaved) {
        open.closeWhenSaved = false;
        this.close();
      }
      return;
    }
    this.#saved(open, { keyboard, undo, sections });
  }

  #saved(open, { keyboard, undo, sections }) {
    const names = this.#names;
    const quiet = keyboard || reduced();
    const { save } = open;
    save.dataset.state = "done";
    open.saveIcon.dataset.state = "done";
    open.saveIcon.replaceChildren(icon("check", "icon draw"));
    roll(open.saveSuffix, names.save.done);
    if (!quiet) play(save, [{ transform: "scale(1.03)" }, { transform: "none" }], SPRINGS.pop);
    this.#marks({ leaving: true });
    this.#renderFooter();
    for (const mascot of [open.construtor.preview, open.idMascot]) {
      mascot?.setState("approved", { instant: keyboard });
    }
    // The toast waits for the panel to close: after Approved's 1.1 s, or sooner if the owner
    // closes it, unless they went on editing.
    open.toast = { agentId: open.agent.id, name: open.saved.profile.name, undo, sections };
    this.#timers.set(() => {
      for (const mascot of [open.construtor.preview, open.idMascot]) mascot?.setState("idle");
    }, APPROVED_MS);
    if (open.closeWhenSaved) {
      open.closeWhenSaved = false;
      this.close({ force: true });
      return;
    }
    open.closeTimer = this.#timers.set(() => {
      if (this.#open === open) this.close({ force: true });
    }, APPROVED_MS);
  }

  #resetSave(open) {
    delete open.save.dataset.state;
    delete open.saveIcon.dataset.state;
    open.saveIcon.replaceChildren();
    roll(open.saveSuffix, this.#names.save.idle);
    this.#renderFooter();
  }

  /** A toast says it saved, and Undo sends back what was saved before, for 10 s (5.13). */
  #toast({ agentId, name, undo, sections }) {
    const names = this.#names;
    const what = { profile: sections.includes("profile"), mascot: sections.includes("mascot") };
    this.#toasts.show({
      text: names.saved(name, what),
      detail: what.mascot ? names.photoSoon : "",
      undo: true,
      action: {
        label: names.undo,
        run: async () => {
          const back = await Promise.all(
            sections.map(async (section) => this.#send(agentId, section, undo[section])),
          );
          const changes = Object.assign(
            {},
            ...back.filter((result) => result.ok).map((result) => result.value),
          );
          if (Object.keys(changes).length > 0) this.#onSaved(agentId, changes);
          const ok = back.every((result) => result.ok);
          this.#toasts.show(
            ok ? { text: names.undone(name) } : { text: names.undoFailed, error: true },
          );
        },
      },
    });
  }

  /**
   * A save that fails in part names what didn't save, keeps that section's mark in --danger, and
   * offers to save it again (Hermes' dirty flag per section).
   */
  #failed(failed, saved) {
    const open = this.#open;
    const names = this.#names;
    open.footer = "failed";
    this.#resetSave(open);
    this.#marks();
    const both = failed.length > 1;
    const { foot } = open;
    foot.className = "editor-foot fail";
    foot.replaceChildren();
    foot.setAttribute("role", "alert");
    const text = element("p");
    const title = element("b");
    title.textContent = both ? names.failed.both : names.failed[failed[0]];
    const detail = element("span");
    detail.textContent = saved.length > 0 ? names.stillSaved[saved[0]] : names.tryAgain;
    text.append(title, detail);
    const retry = element("button", "btn primary");
    retry.type = "button";
    retry.textContent = both ? names.retry.both : names.retry[failed[0]];
    retry.addEventListener("click", () => this.save({ keyboard: fromKeyboard() }));
    foot.append(icon("alert"), text, retry);
    if (!fromKeyboard() && !reduced()) enter(foot, { spring: SPRINGS.fast, rise: 4 });
  }
}
