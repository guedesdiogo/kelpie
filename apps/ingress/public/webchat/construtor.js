// The agent editor's Mascot section (#379), ported from the mascot lab's "Construtor": a preview
// on a small stage that stays pettable, Undo and Randomize as icon buttons, and one tab per axis.
// Each axis is a named radiogroup (APG radio) whose tiles draw the option on this agent's mascot;
// colors are named swatches, a part's variation is a second radiogroup, and cheeks a switch.
// The preview changes live; nothing is saved until the editor's one Save.

import {
  AXES,
  CHOICES,
  changedAxis,
  PARTS,
  randomizeAxis,
  randomLook,
  summaryOf,
  withType,
} from "./editor-model.js";
import { icon } from "./icons.js";
import { Mascot } from "./mascot.js";
import { fadeIn, fromKeyboard, play, reduced, SPRINGS } from "./motion.js";
import { tips } from "./tips.js";

/** The preview and the tiles, at the sizes 5.25 sets; the phone's sheet draws a smaller preview. */
export const PREVIEW_PX = 160;
export const SHEET_PREVIEW_PX = 120;
export const TILE_PX = 46;
/** An option Undo brought back takes a tint this long (5.5's landing tint). */
export const UNDONE_MS = 400;

const element = (tag, className) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  return made;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let ids = 0;

export class Construtor {
  #names;
  #onChange;
  #random;
  /** Every step since the editor opened: the look before it, and what it changed. */
  #history = [];
  #axis = "shape";
  #tabs = new Map();
  #panel;
  #panelHead;
  #count;
  #randomAxis;
  #groups;
  #undo;
  #summary;
  #previewPx;

  /**
   * @param {{ names: object, look: object, onChange: (look: object) => void,
   *   previewPx?: number, random?: () => number }} options `names` is the page's `editor` texts.
   */
  constructor({ names, look, onChange, previewPx = PREVIEW_PX, random = Math.random }) {
    this.#names = names;
    this.#previewPx = previewPx;
    this.#onChange = onChange;
    this.#random = random;
    this.look = look;
    const id = `construtor-${++ids}`;
    this.element = element("div", "construtor");

    const top = element("div", "ed-top");
    const stage = element("div", "stagebox");
    this.host = element("span", "mascot-host preview");
    this.host.setAttribute("role", "img");
    this.host.setAttribute("aria-labelledby", `${id}-summary`);
    stage.append(this.host);
    const side = element("div", "pv-side");
    this.#summary = element("p", "pv-sum");
    this.#summary.id = `${id}-summary`;
    this.#summary.setAttribute("aria-live", "polite");
    const actions = element("div", "pv-act");
    this.#undo = this.#iconButton("undo", names.undo);
    this.#undo.addEventListener("click", () => this.undo());
    const shuffle = this.#iconButton("dice", names.randomizeAll);
    shuffle.addEventListener("click", (event) =>
      this.randomize({ keyboard: event.detail === 0 || fromKeyboard(), die: shuffle }),
    );
    actions.append(this.#undo, shuffle);
    const hint = element("p", "pv-hint");
    hint.textContent = names.hint;
    side.append(this.#summary, actions, hint);
    top.append(stage, side);

    // One tab per axis (APG tabs): the arrows move and select, Home and End go to the ends.
    const tablist = element("div", "axis-tabs");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", names.parts);
    this.#panel = element("div", "axis-panel");
    this.#panel.id = `${id}-panel`;
    this.#panel.setAttribute("role", "tabpanel");
    for (const axis of AXES) {
      const tab = element("button", "axis-tab");
      tab.type = "button";
      tab.id = `${id}-${axis}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", this.#panel.id);
      tab.textContent = names.axes[axis];
      tab.addEventListener("click", () => this.show(axis));
      this.#tabs.set(axis, tab);
      tablist.append(tab);
    }
    tablist.addEventListener("keydown", (event) => this.#tabKey(event));
    this.#panelHead = element("div", "tabp-h");
    this.#count = element("span", "cnt");
    this.#randomAxis = this.#iconButton("dice", "", "sm");
    this.#randomAxis.addEventListener("click", (event) =>
      this.randomize({
        axis: this.#axis,
        keyboard: event.detail === 0 || fromKeyboard(),
        die: this.#randomAxis,
      }),
    );
    this.#panelHead.append(this.#count, this.#randomAxis);
    this.#groups = element("div", "axis-groups");
    this.#panel.append(this.#panelHead, this.#groups);
    this.element.append(top, tablist, this.#panel);
    tips(this.element);
    // Petting it is what a tap on a mascot means (5.19); the editor opens only from its pencil.
    this.host.addEventListener("click", () => this.preview?.pet());
  }

  /** Draws the preview, once the section is on the page: the engine reads its color from it. */
  mount() {
    if (!this.preview) {
      this.preview = new Mascot(this.host, {
        mascot: this.look,
        px: this.#previewPx,
        mode: "large",
      });
    }
    this.show(this.#axis, { instant: true });
    this.#refresh();
  }

  /** Every step since the editor opened, newest last. */
  get steps() {
    return this.#history.length;
  }

  /** The look as it is now, set from outside: a discard, or the saved one again. */
  reset(look) {
    this.#history = [];
    this.#set(look, null);
  }

  /** Shows an axis's tab: its radiogroups, drawn on this agent's mascot. */
  show(axis, { instant = false } = {}) {
    const changed = axis !== this.#axis;
    this.#axis = axis;
    for (const [each, tab] of this.#tabs) {
      tab.setAttribute("aria-selected", String(each === axis));
      tab.tabIndex = each === axis ? 0 : -1;
    }
    this.#panel.setAttribute("aria-labelledby", this.#tabs.get(axis).id);
    this.#groups.replaceChildren(...this.#build(axis));
    this.#refresh();
    if (changed && !instant && !fromKeyboard()) fadeIn(this.#groups);
  }

  /** Undoes the newest step, and the option that came back is marked for a moment. */
  undo() {
    const step = this.#history.pop();
    if (!step) return;
    const axis = changedAxis(this.look, step.look);
    this.#set(step.look, axis);
    this.#markUndone(axis);
  }

  /** Draws every axis again, or one: the die turns, and the mascot jumps into its new look. */
  randomize({ axis = null, keyboard = false, die = null } = {}) {
    const look = axis ? randomizeAxis(this.look, axis, this.#random) : randomLook(this.#random);
    if (same(look, this.look)) return;
    this.#history.push({ look: this.look, step: axis ?? "random" });
    // From the keyboard, the swap happens without the die's turn.
    if (die && !keyboard && !reduced()) {
      play(
        die.querySelector(".icon"),
        [{ transform: "rotate(0deg)" }, { transform: "rotate(90deg)" }],
        SPRINGS.momentFast,
      );
    }
    this.#set(look, axis ?? "random");
  }

  // ── The look ───────────────────────────────────────────────────────────────────────────────

  /** A step the owner took: kept for Undo, then shown. */
  #choose(look, step) {
    if (same(look, this.look)) return;
    this.#history.push({ look: this.look, step });
    this.#set(look, step);
  }

  #set(look, axis) {
    this.look = look;
    if (axis) this.preview?.restyle(look, axis);
    else if (this.preview) this.preview.restyle(look, "color");
    this.#refresh();
    this.#onChange(look);
  }

  /** The summary, Undo's name, and each radio's state and drawing, as the look is now. */
  #refresh() {
    this.#summary.textContent = summaryOf(this.look, this.#names);
    const last = this.#history.at(-1);
    const undo = last ? this.#names.undoStep(this.#names.steps[last.step]) : this.#names.undo;
    this.#undo.setAttribute("aria-label", undo);
    this.#undo.setAttribute("aria-disabled", String(!last));
    this.#undo.dataset.tip = last ? "" : this.#names.nothingToUndo;
    this.#randomAxis.setAttribute(
      "aria-label",
      this.#names.randomize(this.#names.steps[this.#axis]),
    );
    tips(this.element);
    for (const group of this.#groups.querySelectorAll("[role='radiogroup']")) {
      for (const radio of group.querySelectorAll("[role='radio']")) {
        const option = JSON.parse(radio.dataset.option);
        const checked = same(option, group.selected());
        radio.setAttribute("aria-checked", String(checked));
        radio.tabIndex = checked ? 0 : -1;
        const tile = radio.querySelector(".mascot-host");
        if (tile) this.#draw(tile, group.lookOf(option));
      }
    }
    const cheeks = this.#groups.querySelector("[role='switch']");
    cheeks?.setAttribute("aria-checked", String(this.look.cheeks));
    const variations = this.#groups.querySelector(".variations");
    if (variations) variations.hidden = PARTS[this.#axis][this.look[this.#axis].type].length === 0;
  }

  /** A tile draws its option on this agent's mascot, Still, and again only when that changes. */
  #draw(tile, look) {
    const key = JSON.stringify(look);
    if (tile.dataset.look === key || !tile.isConnected) return;
    tile.dataset.look = key;
    tile.replaceChildren();
    new Mascot(tile, { mascot: look, px: TILE_PX, mode: "still" });
  }

  // ── The tabs and their radiogroups ──────────────────────────────────────────────────────────

  #build(axis) {
    const names = this.#names;
    if (axis === "color") {
      this.#count.textContent = names.options(axis, CHOICES.color.length);
      return [
        this.#group(names.axes.color, CHOICES.color, {
          selected: () => this.look.color,
          pick: (color) => this.#choose({ ...this.look, color }, "color"),
          label: (color) => names.colors[color],
          swatch: true,
        }),
      ];
    }
    if (axis === "shape" || axis === "eyes") {
      this.#count.textContent = names.options(axis, CHOICES[axis].length);
      const group = this.#group(names.axes[axis], CHOICES[axis], {
        selected: () => this.look[axis],
        pick: (option) => this.#choose({ ...this.look, [axis]: option }, axis),
        label: (option) => (axis === "shape" ? names.shapes[option] : names.eyes[option]),
        lookOf: (option) => ({ ...this.look, [axis]: option }),
      });
      if (axis === "shape") return [group];
      return [group, this.#cheeks()];
    }
    // A part: its type, then the type's variation, each a radiogroup of its own.
    const types = PARTS[axis];
    const typeNames = axis === "head" ? names.heads : names.accessories;
    const count = Object.values(types).reduce((sum, list) => sum + Math.max(1, list.length), 0);
    this.#count.textContent = names.options(axis, count);
    const typeGroup = this.#group(
      names.axes[axis],
      Object.keys(types).map((type) => ({ type })),
      {
        selected: () => ({ type: this.look[axis].type }),
        pick: ({ type }) =>
          this.#choose({ ...this.look, [axis]: withType(this.look[axis], type, types) }, axis),
        label: ({ type }) => typeNames[type],
        lookOf: ({ type }) => ({ ...this.look, [axis]: withType(this.look[axis], type, types) }),
      },
    );
    const type = this.look[axis].type;
    const variationGroup = this.#group(
      names.variation,
      types[type].map((variation) => ({ type, variation })),
      {
        selected: () => this.look[axis],
        pick: (part) => this.#choose({ ...this.look, [axis]: part }, axis),
        label: (part) => names.variations[part.type][part.variation],
        lookOf: (part) => ({ ...this.look, [axis]: part }),
      },
    );
    variationGroup.classList.add("variations");
    // A new type brings its own variations: the second group follows the first.
    typeGroup.addEventListener("picked", () => {
      if (this.look[axis].type === type) return;
      const focused = typeGroup.contains(document.activeElement);
      this.show(axis, { instant: true });
      if (focused) this.#groups.querySelector("[role='radio'][tabindex='0']")?.focus();
    });
    return [typeGroup, variationGroup];
  }

  /**
   * A radiogroup (APG radio): the arrows move and select, and wrap; Tab enters on the checked
   * option. Each option is a tile with its name, or a named swatch for a color.
   */
  #group(label, options, { selected, pick, label: nameOf, lookOf = null, swatch = false }) {
    const group = element("div", swatch ? "tiles swatches" : "tiles");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    group.selected = selected;
    group.lookOf = lookOf;
    const radios = options.map((option) => {
      const radio = element("button", swatch ? "opt swt" : "opt");
      radio.type = "button";
      radio.setAttribute("role", "radio");
      radio.dataset.option = JSON.stringify(option);
      if (swatch) {
        const chip = element("span", "swc");
        chip.style.background = `var(--mascot-${option})`;
        chip.setAttribute("aria-hidden", "true");
        radio.append(chip);
      } else {
        const tile = element("span", "mascot-host tile");
        tile.setAttribute("aria-hidden", "true");
        radio.append(tile);
      }
      const name = element("span", "opt-name");
      name.textContent = nameOf(option);
      radio.append(name);
      radio.addEventListener("click", () => {
        pick(option);
        group.dispatchEvent(new Event("picked"));
      });
      return radio;
    });
    group.append(...radios);
    group.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      const index = radios.indexOf(event.target);
      if (step === undefined || index === -1) return;
      event.preventDefault();
      const next = radios[(index + step + radios.length) % radios.length];
      next.click();
      // A new type redraws the groups: focus follows the option, wherever it is now.
      const option = next.dataset.option;
      const now = [...this.#groups.querySelectorAll("[role='radio']")].find(
        (radio) => radio.dataset.option === option,
      );
      (now ?? next).focus();
    });
    return group;
  }

  /** Rosy cheeks, a switch beside the eyes. */
  #cheeks() {
    const button = element("button", "switch");
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(this.look.cheeks));
    const track = element("span", "switch-track");
    track.setAttribute("aria-hidden", "true");
    const words = element("span");
    words.textContent = this.#names.cheeks;
    button.append(track, words);
    button.addEventListener("click", () =>
      this.#choose({ ...this.look, cheeks: !this.look.cheeks }, "cheeks"),
    );
    return button;
  }

  #tabKey(event) {
    const order = [...this.#tabs.values()];
    const index = order.indexOf(document.activeElement);
    if (index === -1) return;
    const to = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: order.length - 1,
    }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const tab = order[(to + order.length) % order.length];
    this.show(AXES[order.indexOf(tab)]);
    tab.focus();
  }

  /**
   * The option Undo brought back takes `--accent` at 22%, fading over 400 ms; a color swatch,
   * which can't show a tint, pops back from 1.25 instead.
   */
  #markUndone(axis) {
    if (axis !== this.#axis && !(axis === "cheeks" && this.#axis === "eyes")) return;
    const target =
      axis === "cheeks"
        ? this.#groups.querySelector("[role='switch']")
        : this.#groups.querySelector(".tiles:not(.variations) [aria-checked='true']");
    if (!target) return;
    if (axis === "color") {
      if (!reduced())
        play(target, [{ transform: "scale(1.25)" }, { transform: "none" }], SPRINGS.pop);
      return;
    }
    play(
      target,
      [
        { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)" },
        { backgroundColor: "transparent" },
      ],
      { duration: UNDONE_MS, easing: "cubic-bezier(0, 0, .2, 1)" },
    );
  }

  /** An icon button that says its name in a tooltip (tips.js), never with `title`. */
  #iconButton(name, label, size = "") {
    const button = element("button", size ? `icb ${size}` : "icb");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.dataset.tip = "";
    button.append(icon(name));
    return button;
  }
}
