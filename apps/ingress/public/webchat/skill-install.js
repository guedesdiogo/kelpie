// Installing a skill, always reviewed (#381, ADR-0058 §5, docs/design-system.md 5.25). From a GitHub
// address, a `.zip` or `.skill` file, or pasted text, context-store fetches, checks and stages it
// outside the vault; this shows what it staged: its SKILL.md, every file, and the static scan. The
// owner's Install adds a pending change, which Save writes. The fetch button becomes its own ring,
// as the App Store's Get does; the phases are the real ones; errors stay in the card, with the input.

import { renderBlocks } from "./blocks.js";
import { originLine, repositoryOf, sizeLabel } from "./files-model.js";
import { icon } from "./icons.js";
import { readMarkdown } from "./markdown.js";
import { DUR, EASE, fromKeyboard, play, reduced, SPRINGS } from "./motion.js";
import { roll, rollText } from "./roll.js";

/** The sources, in the research's order. */
export const SOURCES = ["github", "archive", "text"];

const element = (tag, className) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  return made;
};

const button = (className, text) => {
  const made = element("button", className);
  made.type = "button";
  if (text !== undefined) made.textContent = text;
  return made;
};

const ICONS = { github: "link", archive: "file", text: "paste" };

export class SkillInstall {
  #names;
  #blockTexts;
  #fetchSkill;
  #onMascot;
  #onInstall;
  source = "github";
  busy = false;
  staged = null;

  /**
   * @param {{ names: object, blockTexts: object,
   *   fetchSkill: (source: object) => Promise<object>, onMascot: (state: string) => void,
   *   onBack: () => void, onInstall: (staged: object, from: DOMRect | null) => void }} options
   */
  constructor({ names, blockTexts, fetchSkill, onMascot, onBack, onInstall }) {
    this.#names = names;
    this.#blockTexts = blockTexts;
    this.#fetchSkill = fetchSkill;
    this.#onMascot = onMascot;
    this.#onInstall = onInstall;
    const t = this.#t;
    this.element = element("div", "inst");
    const back = button("backb");
    back.append(icon("chevronLeft"), names.files.back);
    back.addEventListener("click", onBack);
    this.back = back;

    // Where from: three segments, an APG radiogroup.
    this.segments = element("div", "seg inst-seg");
    this.segments.setAttribute("role", "radiogroup");
    this.segments.setAttribute("aria-label", t.sources);
    this.radios = {};
    for (const source of SOURCES) {
      const radio = button("seg-b");
      radio.setAttribute("role", "radio");
      radio.append(icon(ICONS[source]), t.source[source]);
      radio.addEventListener("click", () => this.#pick(source));
      this.radios[source] = radio;
      this.segments.append(radio);
    }
    this.segments.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const next = SOURCES[(SOURCES.indexOf(this.source) + step + SOURCES.length) % SOURCES.length];
      this.#pick(next);
      this.radios[next].focus();
    });

    // GitHub: the address, and the button that becomes its own ring.
    this.github = element("div", "field");
    this.address = element("input", "txt");
    this.address.type = "url";
    this.address.inputMode = "url";
    this.address.autocomplete = "off";
    this.address.spellcheck = false;
    this.address.placeholder = t.placeholder;
    this.address.setAttribute("aria-label", t.address);
    this.address.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.#fetch();
      }
    });
    this.get = button("get");
    this.getLabel = element("span", "gl");
    this.getLabel.textContent = t.fetch;
    this.get.append(this.getLabel);
    this.get.addEventListener("click", () => this.#fetch());
    this.github.append(icon("link"), this.address, this.get);

    // A file: chosen, or dropped anywhere on the pane.
    this.archive = element("div", "drop");
    this.fileInput = element("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".zip,.skill";
    this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", () => {
      const [file] = this.fileInput.files ?? [];
      if (file) this.#fetch(file);
    });
    const choose = button("btn ghost", t.choose);
    choose.addEventListener("click", () => this.fileInput.click());
    this.choose = choose;
    const dropHint = element("span");
    dropHint.textContent = t.dropHere;
    this.archive.append(this.fileInput, choose, dropHint);
    this.element.addEventListener("dragover", (event) => {
      if (this.source !== "archive" && this.source !== "github") return;
      event.preventDefault();
      this.element.dataset.dragging = "";
    });
    this.element.addEventListener("dragleave", () => delete this.element.dataset.dragging);
    this.element.addEventListener("drop", (event) => {
      delete this.element.dataset.dragging;
      const [file] = event.dataTransfer?.files ?? [];
      if (!file) return;
      event.preventDefault();
      this.#pick("archive");
      this.#fetch(file);
    });

    // Pasted text: a SKILL.md alone.
    this.text = element("div", "paste");
    this.pasted = element("textarea", "paste-t");
    this.pasted.setAttribute("aria-label", t.pasteLabel);
    this.pasted.spellcheck = false;
    const review = button("btn primary", t.review);
    review.addEventListener("click", () => this.#fetch());
    this.reviewButton = review;
    this.text.append(this.pasted, review);

    // What happens: the mascot with its magnifier, and the real phase, rolled.
    this.says = element("div", "says");
    this.phase = element("p", "phase");
    this.phase.setAttribute("aria-live", "polite");
    this.phase.append(rollText(t.hint));
    this.says.append(this.phase);
    this.slot = element("div", "slot");
    this.pinned = element("p", "doc-m");
    this.pinned.textContent = t.pinned;
    this.element.append(
      back,
      this.segments,
      this.github,
      this.archive,
      this.text,
      this.says,
      this.slot,
      this.pinned,
    );
    this.#pick("github", { quiet: true });
  }

  get #t() {
    return this.#names.files.installing;
  }

  focus() {
    (this.staged ? this.slot.querySelector(".ib") : this.radios[this.source])?.focus({
      preventScroll: true,
    });
  }

  #pick(source, { quiet = false } = {}) {
    if (this.busy) return;
    this.source = source;
    for (const [name, radio] of Object.entries(this.radios)) {
      radio.setAttribute("aria-checked", String(name === source));
      radio.tabIndex = name === source ? 0 : -1;
    }
    this.github.hidden = source !== "github";
    this.archive.hidden = source !== "archive";
    this.text.hidden = source !== "text";
    this.pinned.hidden = source !== "github";
    if (!quiet) this.#clear();
  }

  #clear() {
    this.slot.replaceChildren();
    this.staged = null;
    this.#resetGet();
  }

  #resetGet() {
    this.get.className = "get";
    this.get.removeAttribute("aria-disabled");
    this.get.replaceChildren(this.getLabel);
  }

  /** Fetches and stages: the button becomes a ring, and the phase says what is being fetched. */
  async #fetch(file) {
    if (this.busy) return;
    const t = this.#t;
    let source;
    let what;
    if (file) {
      source = { file };
      what = t.reading(file.name);
    } else if (this.source === "github") {
      const address = this.address.value.trim();
      if (address === "") {
        this.address.focus();
        return;
      }
      source = { github: address };
      what = t.fetching(repositoryOf(address) ?? address);
    } else {
      if (this.pasted.value.trim() === "") {
        this.pasted.focus();
        return;
      }
      source = { text: this.pasted.value };
      what = t.reading("SKILL.md");
    }
    this.busy = true;
    this.slot.replaceChildren();
    this.staged = null;
    if (this.source === "github") this.#ring();
    roll(this.phase, what);
    this.#onMascot("search");
    const result = await this.#fetchSkill(source);
    this.busy = false;
    if (!result.ok) {
      this.#resetGet();
      this.#onMascot("idle");
      roll(this.phase, t.hint);
      this.#error(result.value ?? {});
      return;
    }
    const { staged } = result.value;
    if (this.source === "github") this.#done();
    roll(
      this.phase,
      t.checked(
        staged.files.length,
        staged.origin.kind === "github" ? staged.origin.commit.slice(0, 7) : "",
      ),
    );
    this.#onMascot("idle");
    this.review(staged);
  }

  /** The pill becomes its own ring, turning while the fetch waits; never a fake fill. */
  #ring() {
    const before = this.get.offsetWidth;
    this.get.classList.add("busy");
    this.get.setAttribute("aria-disabled", "true");
    this.get.setAttribute("aria-label", this.#t.fetch);
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("class", "ring");
    ring.setAttribute("viewBox", "0 0 24 24");
    ring.setAttribute("aria-hidden", "true");
    const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    for (const [name, value] of Object.entries({ cx: 12, cy: 12, r: 9, class: "track" }))
      track.setAttribute(name, String(value));
    const arc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    for (const [name, value] of Object.entries({
      cx: 12,
      cy: 12,
      r: 9,
      class: "arc",
      pathLength: 1,
    }))
      arc.setAttribute(name, String(value));
    ring.append(track, arc);
    this.get.replaceChildren(ring);
    if (!fromKeyboard() && !reduced()) {
      play(this.get, [{ inlineSize: `${before}px` }, { inlineSize: "30px" }], SPRINGS.base);
    }
  }

  #done() {
    this.get.className = "get ok";
    this.get.replaceChildren(icon("check", "icon draw"));
  }

  /** An error stays where the card would be, and the input stays as it was. */
  #error(value) {
    const t = this.#t;
    const errors = t.errors;
    const reason = value.reason;
    let message;
    if (reason === "too_large") message = errors.too_large(value.detail ?? null);
    else if (reason === "no_skill") message = errors.no_skill(t.where[this.source]);
    else if (reason === "many_skills") message = errors.many_skills((value.names ?? []).join(", "));
    else if (reason === "unsafe_path" || reason === "link")
      message = errors[reason](value.detail ?? "");
    else if (reason === "invalid_skill") {
      message =
        this.#names.files.skillProblems[value.detail] ?? this.#names.files.refusals.skill_invalid;
    } else if (reason === "vault_off") message = this.#names.files.vaultOff;
    else message = errors[reason] ?? errors.failed;
    const line = element("p", "inst-error");
    line.setAttribute("role", "alert");
    line.append(icon("alert"), message);
    this.slot.replaceChildren(line);
  }

  /** The review card: the field's place opens into it, its height on --spring-moment. */
  review(staged, { update = false } = {}) {
    const t = this.#t;
    this.staged = staged;
    if (update) {
      // An update arrives from the skill's own page: the source's field shows where it comes from.
      this.#pick("github", { quiet: true });
      if (staged.origin.kind === "github") {
        this.address.value = `github.com/${staged.origin.owner}/${staged.origin.repo}`;
      }
    }
    const card = element("div", "rev");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", t.review);
    const head = element("div", "rev-h");
    const name = element("b");
    name.textContent = staged.name;
    const description = element("span", "rd");
    description.textContent = staged.description;
    head.append(name, description);
    const meta = element("span", "src");
    meta.textContent = [
      originLine(staged.origin, this.#names.files) || this.#names.files.origins[staged.origin.kind],
      t.files(staged.files.length, sizeLabel(staged.bytes, document.documentElement.lang || "en")),
    ]
      .filter(Boolean)
      .join(" · ");
    card.append(head, meta);
    if (staged.replaces) card.append(...this.#replaces(staged));
    card.append(this.#files(staged));
    if (staged.leftOut.length > 0) {
      const left = element("p", "rev-left");
      left.textContent = t.leftOut(staged.leftOut.length);
      card.append(left);
    }
    card.append(...this.#scan(staged));
    const preview = element("div", "md rev-md");
    preview.hidden = true;
    const actions = element("div", "rev-a");
    const show = button("btn ghost", t.showSkillMd);
    show.setAttribute("aria-expanded", "false");
    show.addEventListener("click", () => {
      preview.hidden = !preview.hidden;
      show.setAttribute("aria-expanded", String(!preview.hidden));
      show.textContent = preview.hidden ? t.showSkillMd : t.hideSkillMd;
      if (!preview.hidden && !preview.firstChild) {
        preview.append(renderBlocks(readMarkdown(staged.skillMd), this.#blockTexts));
      }
    });
    actions.append(show);
    if (staged.scan.verdict !== "blocked") {
      const install = button("btn primary ib");
      const label = element("span", "il");
      label.append(rollText(t.button.idle));
      install.append(label);
      install.addEventListener("click", () => this.#install(card, install, label));
      actions.append(install);
    }
    card.append(preview, actions);
    this.slot.replaceChildren(card);
    if (fromKeyboard()) return;
    if (reduced()) {
      play(card, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.fade, easing: EASE.fade });
      return;
    }
    const height = card.offsetHeight;
    play(
      card,
      [
        { blockSize: "0px", opacity: 0 },
        { blockSize: `${height}px`, opacity: 1 },
      ],
      SPRINGS.moment,
    );
    [...card.children].forEach((child, index) => {
      play(
        child,
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "none" },
        ],
        { ...SPRINGS.base, delay: 60 + Math.min(index * 30, 300), fill: "backwards" },
      );
    });
  }

  #replaces(staged) {
    const t = this.#t;
    const parts = [];
    const replaces = element("p", "rev-replaces");
    replaces.textContent = t.replaces(staged.name);
    parts.push(replaces);
    if (staged.replaces.edited) {
      const warn = element("p", "rev-warn");
      warn.setAttribute("role", "note");
      warn.append(icon("alert"), t.editedWarning);
      parts.push(warn);
    }
    if (staged.replaces.changes.length > 0) {
      const changes = element("ul", "files rev-changes");
      for (const change of staged.replaces.changes) {
        const item = element("li");
        const path = element("span", "mono");
        path.textContent = change.path;
        const tag = element("span", `tag ${change.change}`);
        tag.textContent = t.changes[change.change];
        item.append(path, tag);
        changes.append(item);
      }
      parts.push(changes);
    }
    const changed = staged.replaces.diff.filter((line) => line.op !== "=");
    if (changed.length > 0) {
      const box = element("details", "rev-diff");
      const summary = element("summary");
      summary.textContent = t.difference;
      const pre = element("pre");
      for (const line of staged.replaces.diff) {
        const row = element("span", line.op === "+" ? "add" : line.op === "-" ? "del" : "same");
        row.textContent = `${line.op === "=" ? " " : line.op} ${line.text}\n`;
        pre.append(row);
      }
      box.append(summary, pre);
      parts.push(box);
    }
    return parts;
  }

  #files(staged) {
    const t = this.#t;
    const list = element("ul", "files");
    const executables = new Set(
      staged.scan.findings
        .filter((finding) => finding.kind === "executable")
        .map((finding) => finding.path),
    );
    for (const file of staged.files) {
      const item = element("li");
      const path = element("span", "mono");
      path.textContent = file.path;
      item.append(path);
      const tag = executables.has(file.path)
        ? t.kinds.executable
        : file.script
          ? t.script
          : file.binary
            ? t.binary
            : "";
      if (tag) {
        const label = element("span", "tag");
        label.textContent = tag;
        item.append(label);
      }
      list.append(item);
    }
    return list;
  }

  /** The verdict by trust level, and the findings by file and line (Hermes's `skills_guard`). */
  #scan(staged) {
    const t = this.#t;
    const { verdict, findings, more } = staged.scan;
    const line = element("p", `scan ${verdict}`);
    line.append(icon(verdict === "clean" ? "check" : "alert"));
    line.append(
      verdict === "caution" ? t.verdict.caution(findings.length + more) : t.verdict[verdict],
    );
    if (findings.length === 0) return [line];
    const list = element("ul", "findings");
    for (const finding of findings) {
      const item = element("li");
      const where = element("span", "mono");
      where.textContent = t.at(finding.path, finding.line);
      const kind = element("span", "kind");
      kind.textContent = t.kinds[finding.kind] ?? finding.kind;
      item.append(where, kind);
      if (finding.excerpt) {
        const excerpt = element("code");
        excerpt.textContent = finding.excerpt;
        item.append(excerpt);
      }
      list.append(item);
    }
    if (more > 0) {
      const rest = element("li", "more");
      rest.textContent = t.more(more);
      list.append(rest);
    }
    return [line, list];
  }

  /**
   * Install, Adding, then a check: the same button. It adds a pending change Save writes; the card
   * folds into a chip (scaleY 0.98), and the sections carry it to the list.
   */
  #install(card, install, label) {
    const t = this.#t;
    if (install.dataset.state) return;
    install.dataset.state = "busy";
    install.setAttribute("aria-disabled", "true");
    roll(label, t.button.busy);
    const staged = this.staged;
    const finish = () => {
      install.dataset.state = "done";
      install.classList.add("ok");
      label.replaceChildren(icon("check", "icon draw"), rollText(t.button.done));
      if (!fromKeyboard() && !reduced()) {
        play(install, [{ transform: "scale(1.03)" }, { transform: "none" }], SPRINGS.pop);
      }
      const from = card.getBoundingClientRect();
      if (fromKeyboard() || reduced()) {
        this.#onInstall(staged, null);
        return;
      }
      const fold = play(
        card,
        [
          { transform: "none", opacity: 1 },
          { transform: "scaleY(0.98)", opacity: 0 },
        ],
        {
          duration: DUR.exitMoment,
          easing: EASE.exit,
          fill: "forwards",
        },
      );
      const hand = () => this.#onInstall(staged, from);
      if (fold) fold.finished.then(hand, hand);
      else hand();
    };
    requestAnimationFrame(finish);
  }
}
