// Reading and editing one of an agent's Markdown files (#381, docs/design-system.md 5.25). The file
// opens formatted, through blocks.js, and a Visualizar / Editar switch shows its plain text, as the
// owner asked; ⌘E or Ctrl+E toggles it. Switching keeps the place, as VS Code and iA Writer do: the
// first block in view keeps its offset, Editar puts the caret on its line, and a 2 px --accent bar
// marks the line, then fades. The plain text is a real textarea over a copy of its lines, which
// dims the Markdown's marks and marks the caret's line; nothing from the file is parsed as HTML.

import { renderBlocks } from "./blocks.js";
import { icon } from "./icons.js";
import { lineMark, readMarkdown } from "./markdown.js";
import { DUR, EASE, fromKeyboard, play, REPLY_TEXT_DELAY, reduced, SPRINGS } from "./motion.js";

/** The view the page remembers, in this browser. */
export const VIEW_KEY = "kelpie.fileView";
/** Up to this many blocks slide to their new places; the rest only crossfade. */
export const MAX_SLIDES = 20;
/** The bar that marks the line you were on, held then faded. */
export const ANCHOR_MS = 1_100;

const element = (tag, className) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  return made;
};

export function rememberedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === "edit" ? "edit" : "read";
  } catch {
    return "read";
  }
}

function remember(mode) {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // A private window keeps no choice; the view still switches.
  }
}

/** ⌘E on a Mac, Ctrl+E elsewhere: what the tooltip says. */
export const shortcutLabel = () =>
  /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘E" : "Ctrl+E";

export class FileView {
  #names;
  #onInput;
  #lines = [];
  #caretLine = -1;

  /**
   * @param {{ names: object, label: string, path: string, content: string, about?: string,
   *   mode?: "read" | "edit", onInput?: (text: string) => void }} options
   */
  constructor({
    names,
    label,
    path,
    content,
    about = "",
    mode = rememberedView(),
    onInput = () => {},
  }) {
    this.#names = names;
    this.#onInput = onInput;
    this.mode = mode;

    // The header's part: the path, in Geist Mono, and the switch.
    this.controls = element("div", "file-controls");
    this.path = element("span", "path");
    this.path.textContent = path;
    this.switch = element("span", "mode");
    this.switch.setAttribute("role", "radiogroup");
    this.switch.setAttribute("aria-label", names.view.group);
    this.indicator = element("span", "mode-ind");
    this.indicator.setAttribute("aria-hidden", "true");
    this.radios = {
      read: this.#radio("read", "book", names.view.read),
      edit: this.#radio("edit", "pencilLine", names.view.edit),
    };
    this.switch.append(this.indicator, this.radios.read, this.radios.edit);
    this.switch.addEventListener("keydown", (event) => this.#switchKey(event));
    this.controls.append(this.path, this.switch);

    this.element = element("div", "fileview");
    this.anchor = element("span", "anchor");
    this.anchor.setAttribute("aria-hidden", "true");
    this.view = element("div", "md");
    this.view.addEventListener("dblclick", (event) => {
      const block = event.target instanceof Element ? event.target.closest("[data-line]") : null;
      this.setMode("edit", { line: block ? Number(block.dataset.line) : 0 });
    });
    this.doc = element("div", "doc");
    this.marks = element("div", "doc-lines");
    this.marks.setAttribute("aria-hidden", "true");
    this.input = element("textarea", "doc-input");
    this.input.setAttribute("aria-label", label);
    this.input.spellcheck = true;
    this.input.value = content;
    this.input.addEventListener("input", () => {
      this.#drawLines();
      this.#fit();
      this.#onInput(this.input.value);
    });
    for (const type of ["keyup", "click", "select", "focus"]) {
      this.input.addEventListener(type, () => this.#markCaret());
    }
    this.input.addEventListener("blur", () => this.#markCaret(-1));
    this.doc.append(this.marks, this.input);
    this.meta = element("div", "doc-m");
    this.about = element("span");
    this.about.textContent = about;
    this.count = element("span", "count");
    this.meta.append(this.about, this.count);
    this.element.append(this.anchor, this.view, this.doc, this.meta);
    this.#drawLines();
    this.#show(this.mode);
  }

  get value() {
    return this.input.value;
  }

  /** Lays the switch's indicator under its checked segment, once the section shows. */
  mount() {
    this.#placeIndicator(true);
    this.#fit();
  }

  toggle(how = {}) {
    this.setMode(this.mode === "read" ? "edit" : "read", how);
  }

  /**
   * Switches views, keeping the place: the first block in view stays where it was, before paint.
   * `line` puts the caret there instead, as a double-click does.
   */
  setMode(mode, { line, keyboard = fromKeyboard() } = {}) {
    if (mode === this.mode) return;
    const scroller = this.element.closest(".editor-body") ?? this.element;
    const place = line === undefined ? this.#firstInView(scroller) : { line, offset: null };
    const before = keyboard || reduced() ? null : this.#rects();
    const leaving = this.mode === "read" ? this.view : this.doc;
    const was = leaving.getBoundingClientRect();
    const typing = document.activeElement === this.input;
    this.mode = mode;
    remember(mode);
    this.#show(mode);
    this.#placeIndicator(keyboard);
    const target = this.#elementAt(place.line);
    if (target) {
      const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const offset = place.offset ?? 24;
      scroller.scrollTop += top - offset;
      this.#markAnchor(target);
    }
    if (mode === "edit") {
      const at = this.#offsetOfLine(place.line);
      this.input.focus({ preventScroll: true });
      this.input.setSelectionRange(at, at);
      this.#markCaret();
    } else if (typing) {
      // The field that had the keys hides: they go to the switch, so ⌘E and ⌘S still reach the editor.
      this.radios.read.focus({ preventScroll: true });
    }
    if (keyboard) return;
    this.#crossfade(leaving, was, mode === "edit" ? this.doc : this.view);
    if (before) this.#slide(before);
  }

  // ── The switch ──────────────────────────────────────────────────────────────────────────────

  #radio(mode, glyph, name) {
    const radio = element("button", "seg-b");
    radio.type = "button";
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-label", name);
    radio.dataset.tip = name;
    radio.dataset.kbd = shortcutLabel();
    radio.setAttribute("aria-keyshortcuts", "Meta+E Control+E");
    radio.append(icon(glyph));
    radio.addEventListener("click", (event) =>
      this.setMode(mode, { keyboard: event.detail === 0 || fromKeyboard() }),
    );
    return radio;
  }

  /** APG radio: the arrows move and select, and wrap. */
  #switchKey(event) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = this.mode === "read" ? "edit" : "read";
    this.setMode(next, { keyboard: true });
    this.radios[next].focus();
  }

  #placeIndicator(instant) {
    const radio = this.radios[this.mode];
    const from = this.indicatorAt;
    const to = { x: radio.offsetLeft, w: radio.offsetWidth };
    this.indicator.style.transform = `translateX(${to.x}px)`;
    this.indicator.style.inlineSize = `${to.w}px`;
    this.indicatorAt = to;
    if (instant || !from || reduced()) return;
    play(
      this.indicator,
      [{ transform: `translateX(${from.x}px)` }, { transform: `translateX(${to.x}px)` }],
      SPRINGS.fast,
    );
  }

  #show(mode) {
    for (const [name, radio] of Object.entries(this.radios)) {
      radio.setAttribute("aria-checked", String(name === mode));
      radio.tabIndex = name === mode ? 0 : -1;
    }
    this.element.dataset.mode = mode;
    if (mode === "read") this.#drawView();
    this.view.hidden = mode !== "read";
    this.doc.hidden = mode !== "edit";
    this.#count();
    if (mode === "edit") this.#fit();
  }

  #count() {
    this.count.textContent = this.#names.chars(this.input.value);
  }

  // ── The two views ───────────────────────────────────────────────────────────────────────────

  #drawView() {
    this.view.replaceChildren(renderBlocks(readMarkdown(this.input.value), this.#names.blockTexts));
    if (!this.view.firstChild) {
      const empty = element("p", "md-empty");
      empty.textContent = this.#names.emptyFile;
      this.view.append(empty);
    }
  }

  /** The text's lines, each its Markdown marks in --muted and then the rest, for the eye only. */
  #drawLines() {
    const text = this.input.value;
    const lines = text.split("\n");
    this.#lines = lines;
    let inFence = false;
    const rows = lines.map((line, index) => {
      const row = element("div");
      row.dataset.line = String(index);
      const mark = inFence && !/^ {0,3}(`{3,}|~{3,})/.test(line) ? "" : lineMark(line);
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      if (mark) {
        const muted = element("span", "mk");
        muted.textContent = mark;
        row.append(muted, line.slice(mark.length));
      } else {
        // An empty line keeps its height through the stylesheet's min-block-size.
        row.textContent = line;
      }
      if (/^ {0,3}#{1,6}[ \t]/.test(line)) row.className = "h";
      return row;
    });
    this.marks.replaceChildren(...rows);
    this.#caretLine = -1;
    if (document.activeElement === this.input) this.#markCaret();
  }

  /** The textarea grows with its text, so the panel's body scrolls, not the field. */
  #fit() {
    if (this.doc.hidden) return;
    this.input.style.blockSize = "auto";
    this.input.style.blockSize = `${Math.max(this.input.scrollHeight, this.marks.scrollHeight)}px`;
  }

  /** The caret's line: --accent at 7% and a 2 px bar. */
  #markCaret(line = this.#lineAtCaret()) {
    if (line === this.#caretLine) return;
    this.marks.querySelector(".cur")?.classList.remove("cur");
    this.#caretLine = line;
    if (line >= 0) this.marks.children[line]?.classList.add("cur");
  }

  #lineAtCaret() {
    const at = this.input.selectionStart ?? 0;
    let line = 0;
    for (
      let i = this.input.value.indexOf("\n");
      i !== -1 && i < at;
      i = this.input.value.indexOf("\n", i + 1)
    ) {
      line += 1;
    }
    return line;
  }

  #offsetOfLine(line) {
    let at = 0;
    for (let i = 0; i < line && i < this.#lines.length; i += 1)
      at += (this.#lines[i] ?? "").length + 1;
    return Math.min(at, this.input.value.length);
  }

  // ── Keeping the place ───────────────────────────────────────────────────────────────────────

  /**
   * What holds each line in the view now showing: the read view's innermost blocks, a list's items
   * rather than the list, or the edit view's lines.
   */
  #blocks() {
    if (this.mode === "edit") return [...this.marks.children];
    return [...this.view.querySelectorAll("[data-line]")].filter(
      (node) => !node.querySelector("[data-line]"),
    );
  }

  /** The first block, or line, in view, and how far it sits below the scroller's top. */
  #firstInView(scroller) {
    const top = scroller.getBoundingClientRect().top;
    for (const node of this.#blocks()) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > top)
        return { line: Number(node.dataset.line), offset: Math.max(0, rect.top - top) };
    }
    return { line: 0, offset: null };
  }

  /** What shows the source line `line` in the view now showing. */
  #elementAt(line) {
    if (this.mode === "edit")
      return this.marks.children[Math.min(line, this.marks.children.length - 1)] ?? null;
    let found = null;
    for (const node of this.#blocks()) {
      if (Number(node.dataset.line) > line) break;
      found = node;
    }
    return found ?? this.view.querySelector("[data-line]");
  }

  #rects() {
    const rects = new Map();
    for (const node of this.#blocks()) rects.set(node.dataset.line, node.getBoundingClientRect());
    return rects;
  }

  /** Up to 20 visible blocks slide from where they were, translate only, with --spring-base. */
  #slide(before) {
    const scroller = this.element.closest(".editor-body") ?? this.element;
    const view = scroller.getBoundingClientRect();
    let moved = 0;
    for (const node of this.#blocks()) {
      if (moved >= MAX_SLIDES) break;
      const from = before.get(node.dataset.line);
      const to = node.getBoundingClientRect();
      if (!from || to.bottom < view.top || to.top > view.bottom) continue;
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx === 0 && dy === 0) continue;
      play(
        node,
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        SPRINGS.base,
      );
      moved += 1;
    }
  }

  /**
   * The views crossfade in --dur-fade: the one leaving stays where it was on screen, over the new
   * one, while it fades. The Markdown's marks fade in 70 ms later.
   */
  #crossfade(leaving, was, entering) {
    play(entering, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.fade, easing: EASE.fade });
    const box = this.element.getBoundingClientRect();
    leaving.hidden = false;
    leaving.classList.add("leaving");
    leaving.style.insetBlockStart = `${was.top - box.top}px`;
    leaving.style.inlineSize = `${was.width}px`;
    const done = () => {
      leaving.classList.remove("leaving");
      leaving.style.insetBlockStart = "";
      leaving.style.inlineSize = "";
      // Unless the owner switched back meanwhile, the view that left is hidden again.
      if ((leaving === this.view) !== (this.mode === "read")) leaving.hidden = true;
    };
    const fading = play(leaving, [{ opacity: 1 }, { opacity: 0 }], {
      duration: DUR.fade,
      easing: EASE.fade,
      fill: "forwards",
    });
    if (fading) fading.finished.then(done, done);
    else done();
    if (entering === this.doc) {
      for (const mark of this.marks.querySelectorAll(".mk")) {
        play(mark, [{ opacity: 0 }, { opacity: 1 }], {
          duration: DUR.fade,
          easing: EASE.fade,
          delay: REPLY_TEXT_DELAY,
          fill: "backwards",
        });
      }
    }
  }

  /** A 2 px --accent bar beside the line you were on, held a moment, then faded. */
  #markAnchor(target) {
    const box = this.element.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    this.anchor.style.insetBlockStart = `${rect.top - box.top}px`;
    this.anchor.style.blockSize = `${Math.max(rect.height, 16)}px`;
    play(this.anchor, [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], {
      duration: ANCHOR_MS,
      easing: EASE.fade,
      fill: "forwards",
    });
  }
}
