// The agent's own files in its editor (#381, docs/design-system.md 5.25): Soul, Rules, Memory and
// Skills, each a section of the editor's frame. They read the files once when the editor opens,
// keep the owner's drafts, and hand one Save its changes; the editor writes them in one request,
// and so in one commit (ADR-0058). A conflict shows the vault's version and keeps the draft.

import { FileView } from "./file-view.js";
import {
  changedFileSections,
  entriesOf,
  entryBreaks,
  fileChanges,
  freeSkillName,
  freshDrafts,
  isSkillName,
  memoryBudget,
  memoryOf,
  newSkill,
  originLine,
  sectionOf,
  shownEntries,
  shownRules,
  shownSoul,
  skillFields,
} from "./files-model.js";
import { icon } from "./icons.js";
import { Mascot } from "./mascot.js";
import { DUR, EASE, enter, fadeIn, fromKeyboard, play, reduced, SPRINGS } from "./motion.js";
import { roll, rollText } from "./roll.js";
import { SkillInstall } from "./skill-install.js";
import { tips } from "./tips.js";

/** The empty Rules' mascot, taking notes. */
export const EMPTY_PX = 104;
/** Digits roll at most once a second (5.16). */
export const ROLL_EVERY_MS = 1_000;
/** What a skill's removal turns --muted: its name, struck, and its tile. */
const PARTS = "b, .skt";

const element = (tag, className) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  return made;
};

/** A field as tall as its text; one not laid out yet, as in a hidden section, keeps its rows. */
function growField(field) {
  field.style.blockSize = "auto";
  if (field.scrollHeight > 0) field.style.blockSize = `${field.scrollHeight}px`;
}

const button = (className, text) => {
  const made = element("button", className);
  made.type = "button";
  if (text !== undefined) made.textContent = text;
  return made;
};

export class FileSections {
  #names;
  #blockTexts;
  #agent;
  #io;
  #onChange;
  #onMascot;
  #timers;
  /** The vault's files as read, or as the last save left them. */
  files = null;
  drafts = freshDrafts();
  /** The version a draft started from, when a conflict moved what the vault holds past it. */
  bases = {};
  /** Each section's conflict: the vault's newer version, kept beside the draft. */
  conflicts = {};
  /** The sections whose save the vault refused, and why. */
  refusals = {};
  state = "loading";

  /**
   * @param {{ names: object, blockTexts: object, agent: { id: string, name: string, mascot: object },
   *   io: { read: Function, fetchSkill: Function }, onChange: () => void,
   *   onMascot?: (state: string) => void, timers?: object }} options
   */
  constructor({ names, blockTexts, agent, io, onChange, onMascot = () => {}, timers }) {
    this.#names = names;
    this.#blockTexts = blockTexts;
    this.#agent = agent;
    this.#io = io;
    this.#onChange = onChange;
    this.#onMascot = onMascot;
    this.#timers = timers ?? {
      set: (run, ms) => setTimeout(run, ms),
      clear: (timer) => clearTimeout(timer),
    };
    this.elements = {};
    for (const section of ["soul", "rules", "memory", "skills"]) {
      const box = element("div", `files-section files-${section}`);
      box.hidden = true;
      this.elements[section] = box;
    }
    // The skills redraw inside their body; what they announce stays put, so it is heard.
    this.skillsBody = element("div", "files-body");
    this.live = element("p", "visually-hidden");
    this.live.setAttribute("aria-live", "polite");
    this.elements.skills.append(this.skillsBody, this.live);
    this.views = {};
    this.skillView = "list";
    this.openSkill = null;
    this.#drawAll();
  }

  get #files() {
    return this.#names.files;
  }

  /** Reads the agent's files; the sections draw them, or why they can't. */
  async load() {
    this.state = "loading";
    this.#drawAll();
    const result = await this.#io.read(this.#agent.id);
    if (result.ok && result.value?.files) {
      this.files = result.value.files;
      this.state = "ready";
    } else {
      this.state = result.value?.reason === "vault_off" ? "off" : "failed";
    }
    this.#drawAll();
    this.#onChange();
  }

  /** The file sections that changed, in the editor's order. */
  changed() {
    return changedFileSections(this.files, this.drafts);
  }

  /** Why Save waits for the files, or null: a memory over its limit, or a SKILL.md it would refuse. */
  blocked() {
    if (!this.files) return null;
    if (this.drafts.memory !== undefined) {
      const budget = memoryBudget(this.drafts.memory);
      if (budget.over > 0 || this.drafts.memory.some(entryBreaks)) return "memory";
    }
    for (const [name, change] of this.drafts.skills) {
      if (typeof change.content === "string" && this.#skillProblem(name, change.content))
        return "skills";
    }
    return null;
  }

  /** The changes one Save sends for these sections. */
  changes(sections) {
    return fileChanges(this.files, this.drafts, sections, this.bases);
  }

  /**
   * What a save answered for the changes it sent: the files it now holds, and for each section
   * whether it saved. A section saves when every change of its saved; one that conflicted keeps
   * its draft and shows the vault's version; one refused says why.
   */
  applySave(sent, result) {
    const outcome = new Map();
    if (!result.ok) {
      for (const change of sent) outcome.set(sectionOf(change), false);
      return { saved: [], failed: [...outcome.keys()], undo: [] };
    }
    const { outcomes, files, undo } = result.value;
    // Only what the answer changes is drawn again: a file the owner is typing in keeps its caret.
    const redraw = new Set();
    sent.forEach((change, index) => {
      const section = sectionOf(change);
      const answer = outcomes[index];
      const ok = answer?.status === "saved";
      outcome.set(section, (outcome.get(section) ?? true) && ok);
      const name =
        change.file === "skill"
          ? change.name
          : change.file === "install"
            ? this.#installName(change.staged)
            : null;
      const key = name !== null ? `skill:${name}` : change.file;
      if (section === "skills") redraw.add("skills");
      if (ok) {
        if (this.conflicts[key] || this.refusals[key]) redraw.add(section);
        delete this.conflicts[key];
        delete this.refusals[key];
        // A draft the owner changed while it saved stays, to save next, on the version written.
        if (!this.#sentDraft(change, name)) {
          this.bases[key] = answer.version;
          return;
        }
        delete this.bases[key];
        // Rows the save trimmed or left out, as an emptied entry, show as the vault keeps them.
        if (change.file === "memory" && !sameRows(this.drafts.memory, entriesOf(change.content))) {
          redraw.add("memory");
        }
        if (name !== null) this.drafts.skills.delete(name);
        else this.drafts[change.file] = undefined;
        return;
      }
      redraw.add(section);
      if (answer?.status === "conflict") {
        // The draft keeps its own base, so saving again can't overwrite the vault's by accident.
        if (!Object.hasOwn(this.bases, key)) this.bases[key] = change.version;
        this.conflicts[key] = { current: answer.current, shown: false, kept: false };
      } else if (answer?.status === "refused") {
        this.refusals[key] = answer.reason;
      }
    });
    this.files = files;
    for (const section of redraw) this.#keepingFocus(section, () => this.#redraw(section));
    const sections = [...outcome];
    return {
      saved: sections.filter(([, ok]) => ok).map(([section]) => section),
      failed: sections.filter(([, ok]) => !ok).map(([section]) => section),
      undo,
    };
  }

  /**
   * Draws a section again where the owner may be typing: the field that had focus, by its place
   * among the section's fields, gets it back with its caret.
   */
  #keepingFocus(section, draw) {
    const box = this.elements[section];
    const active = document.activeElement;
    const fields = () => [...box.querySelectorAll("textarea")];
    const at = active instanceof HTMLTextAreaElement ? fields().indexOf(active) : -1;
    const caret = at >= 0 ? [active.selectionStart, active.selectionEnd] : null;
    draw();
    if (at < 0) return;
    const now = fields();
    const field = now[Math.min(at, now.length - 1)];
    if (!field || field.closest("[hidden]")) return;
    field.focus({ preventScroll: true });
    const end = field.value.length;
    field.setSelectionRange(Math.min(caret[0], end), Math.min(caret[1], end));
  }

  /** Whether the draft is still what this change sent. */
  #sentDraft(change, name) {
    if (name !== null) {
      const draft = this.drafts.skills.get(name);
      return change.file === "install"
        ? draft?.install?.id === change.staged
        : draft !== undefined && draft.content === change.content;
    }
    if (change.file === "memory") {
      return this.drafts.memory !== undefined && memoryOf(this.drafts.memory) === change.content;
    }
    return this.drafts[change.file] === change.content;
  }

  /** Why a section didn't save, in one sentence: a conflict, or what the vault refused. */
  why(section) {
    const names = this.#files;
    const keys =
      section === "skills"
        ? Object.keys({ ...this.conflicts, ...this.refusals }).filter((key) =>
            key.startsWith("skill:"),
          )
        : [section];
    for (const key of keys) {
      if (this.conflicts[key]) return `${names.conflict.title}.`;
      const refusal = this.refusals[key];
      if (refusal) return names.refusals[refusal] ?? names.refusals.invalid;
    }
    return "";
  }

  #installName(staged) {
    for (const [name, change] of this.drafts.skills) if (change.install?.id === staged) return name;
    return null;
  }

  /** What the section's header shows beside its title: a file's path and its switch. */
  controls(section) {
    if (section === "skills") {
      return this.skillView === "detail" ? (this.skillDetail?.view.controls ?? null) : null;
    }
    return this.views[section]?.controls ?? null;
  }

  /** The header's title: a skill's name in its own view, or the install's. */
  title(section) {
    if (section !== "skills") return null;
    if (this.skillView === "install") return this.#files.install;
    if (this.skillView === "detail") return this.openSkill;
    return null;
  }

  /** ⌘E or Ctrl+E: the shown file's other view. */
  toggleView(section) {
    const view = section === "skills" ? this.skillDetail?.view : this.views[section];
    if (!view || this.elements[section].hidden) return false;
    view.toggle({ keyboard: true });
    return true;
  }

  /** The section just showed: its file's switch lays out, and the mascot acts it out. */
  shown(section) {
    this.views[section]?.mount();
    // A memory's rows take their text's height once they can be measured.
    if (section === "memory") this.memoryList?.querySelectorAll("textarea").forEach(growField);
    if (section === "skills") this.skillDetail?.view.mount();
    this.#onMascot(section === "skills" ? "search" : "vault");
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────

  #drawAll() {
    this.#drawSoul();
    this.#drawRules();
    this.#drawMemory();
    this.#drawSkills();
  }

  /** Loading, a vault that is off, or one that failed: the section says so. */
  #notReady(box) {
    if (this.state === "ready") return false;
    const names = this.#files;
    const note = element("div", "files-note");
    note.setAttribute("role", "status");
    if (this.state === "loading") {
      note.append(element("span", "spinner"), names.loading);
    } else {
      note.append(icon("alert"), this.state === "off" ? names.vaultOff : names.readFailed);
      if (this.state === "failed") {
        const retry = button("btn ghost", names.tryAgain);
        retry.addEventListener("click", () => this.load());
        note.append(retry);
      }
    }
    box.replaceChildren(note);
    return true;
  }

  /** A file's view; drawn again, it keeps the view it was in. */
  #fileView(section, path, content, about, onInput, { label, mode } = {}) {
    return new FileView({
      names: { ...this.#files, blockTexts: this.#blockTexts },
      label: label ?? this.#files.fileOf(this.#names.sections[section], this.#agent.name),
      path,
      content,
      about,
      onInput,
      mode,
    });
  }

  #drawSoul() {
    const box = this.elements.soul;
    if (this.#notReady(box)) return;
    const path = `agents/${this.#agent.id}/SOUL.md`;
    const view = this.#fileView(
      "soul",
      path,
      shownSoul(this.files, this.drafts),
      this.#files.soulAbout(this.#agent.name),
      (text) => {
        this.drafts.soul = text;
        delete this.refusals.soul;
        this.#onChange();
      },
      { mode: this.views.soul?.mode },
    );
    this.views.soul = view;
    box.replaceChildren(...this.#banners("soul"), view.element);
  }

  #drawRules() {
    const box = this.elements.rules;
    if (this.#notReady(box)) return;
    const rules = shownRules(this.files, this.drafts);
    if (rules === null) {
      this.views.rules = null;
      box.replaceChildren(this.#emptyRules());
      return;
    }
    const path = `agents/${this.#agent.id}/AGENTS.md`;
    const view = this.#fileView(
      "rules",
      path,
      rules,
      this.#files.rulesAbout(this.#agent.name),
      (text) => {
        this.drafts.rules = text;
        delete this.refusals.rules;
        this.#onChange();
      },
      { mode: this.views.rules?.mode },
    );
    this.views.rules = view;
    box.replaceChildren(...this.#banners("rules"), view.element);
  }

  /** No rules of its own: the mascot taking notes, one line, and one action. */
  #emptyRules() {
    const names = this.#files;
    const empty = element("div", "files-empty");
    const host = element("span", "mascot-host");
    host.setAttribute("aria-hidden", "true");
    const words = element("p");
    const title = element("b");
    title.textContent = names.noRules(this.#agent.name);
    const why = element("span", "why");
    why.textContent = names.noRulesWhy;
    words.append(title, why);
    const create = button("btn primary", names.createRules);
    create.addEventListener("click", () => {
      this.drafts.rules = names.rulesStart(this.#agent.name);
      this.#drawRules();
      this.views.rules.setMode("edit", { line: 2, keyboard: true });
      this.views.rules.mount();
      this.#onChange();
    });
    empty.append(host, words, create);
    new Mascot(host, {
      mascot: this.#agent.mascot,
      px: EMPTY_PX,
      mode: "large",
      state: "working",
    }).setState("working", { activity: "vault", instant: true });
    return empty;
  }

  /** A conflict's banner, or a refusal's line, above a section's file. */
  #banners(key) {
    const banners = [];
    const refusal = this.refusals[key];
    if (refusal && !["memory_too_long", "memory_format"].includes(refusal)) {
      const line = element("p", "files-refused");
      line.setAttribute("role", "alert");
      line.append(icon("alert"), this.#files.refusals[refusal] ?? this.#files.refusals.invalid);
      banners.push(line);
    }
    const conflict = this.conflicts[key];
    if (!conflict) return banners;
    const names = this.#files.conflict;
    const banner = element("div", "files-conflict");
    banner.setAttribute("role", "alert");
    const words = element("p");
    const title = element("b");
    title.textContent = names.title;
    const why = element("span");
    why.textContent = conflict.kept ? names.kept : conflict.current ? names.why : names.gone;
    words.append(title, why);
    const actions = element("div", "files-conflict-a");
    if (conflict.current) {
      const show = button("btn ghost sm", conflict.shown ? names.hide : names.show);
      show.setAttribute("aria-expanded", String(conflict.shown));
      show.addEventListener("click", () => {
        conflict.shown = !conflict.shown;
        this.#redraw(key);
      });
      actions.append(show);
    }
    if (!conflict.kept) {
      const keep = button("btn ghost sm", names.keep);
      keep.addEventListener("click", () => {
        this.bases[key] = conflict.current?.version ?? null;
        conflict.kept = true;
        this.#redraw(key);
        this.#onChange();
      });
      const take = button("btn ghost sm", names.take);
      take.addEventListener("click", () => this.#take(key));
      actions.append(keep, take);
    }
    banner.append(icon("alert"), words, actions);
    banners.push(banner);
    if (conflict.shown && conflict.current) {
      const theirs = element("pre", "files-theirs");
      theirs.textContent = conflict.current.content;
      banners.push(theirs);
    }
    return banners;
  }

  /** The owner takes the vault's version: the draft goes, and the section shows what is saved. */
  #take(key) {
    delete this.conflicts[key];
    delete this.bases[key];
    if (key.startsWith("skill:")) this.drafts.skills.delete(key.slice("skill:".length));
    else this.drafts[key] = undefined;
    this.#redraw(key);
    this.#onChange();
  }

  #redraw(key) {
    if (key === "soul") this.#drawSoul();
    else if (key === "rules") this.#drawRules();
    else if (key === "memory") this.#drawMemory();
    else this.#drawSkills();
    if (!this.elements[key.startsWith("skill:") ? "skills" : key].hidden) {
      this.shown(key.startsWith("skill:") ? "skills" : key);
    }
  }

  // ── Memory ──────────────────────────────────────────────────────────────────────────────────

  #drawMemory() {
    const box = this.elements.memory;
    if (this.#notReady(box)) return;
    const names = this.#files;
    const entries = shownEntries(this.files, this.drafts);
    const path = element("p", "path files-path");
    path.textContent = `agents/${this.#agent.id}/memories/MEMORY.md`;
    // The budget: a bar and "246 of 2,200 characters", whose digits roll (5.16).
    const budget = element("div", "budget");
    budget.setAttribute("role", "meter");
    budget.setAttribute("aria-label", names.meter);
    budget.setAttribute("aria-valuemin", "0");
    const top = element("div", "bt");
    this.budgetCount = element("span", "budget-count");
    this.budgetCount.append(rollText(""));
    this.budgetNote = element("span", "budget-note");
    top.append(this.budgetCount, this.budgetNote);
    const bar = element("div", "bar");
    this.budgetFill = element("i");
    bar.append(this.budgetFill);
    budget.append(top, bar);
    this.budget = budget;
    const list = element("div", "mems");
    this.memoryList = list;
    const add = button("addb");
    add.append(icon("plus"), names.addEntry);
    add.addEventListener("click", () => {
      const now = this.#entries();
      now.push("");
      this.drafts.memory = now;
      const row = this.#entryRow(now.length - 1, "");
      list.querySelector(".mems-empty")?.remove();
      list.append(row);
      if (!fromKeyboard() && !reduced()) enter(row, { spring: SPRINGS.base });
      row.querySelector("textarea").focus();
      this.#updateBudget();
      this.#onChange();
    });
    const about = element("p", "doc-m");
    about.textContent = names.memoryAbout(this.#agent.name);
    box.replaceChildren(path, ...this.#banners("memory"), budget, list, add, about);
    this.#drawEntries(entries);
    this.#updateBudget({ instant: true });
  }

  #entries() {
    return this.drafts.memory ? [...this.drafts.memory] : shownEntries(this.files, this.drafts);
  }

  #drawEntries(entries) {
    const rows = entries.map((entry, index) => this.#entryRow(index, entry));
    if (rows.length === 0) {
      const empty = element("p", "mems-empty");
      empty.textContent = this.#files.noMemories;
      rows.push(empty);
    }
    this.memoryList.replaceChildren(...rows);
  }

  #entryRow(index, text) {
    const names = this.#files;
    const row = element("div", "mem-e");
    const field = element("textarea", "mem-t");
    field.rows = 1;
    field.value = text;
    field.setAttribute("aria-label", names.entry(index + 1));
    const grow = () => growField(field);
    field.addEventListener("input", () => {
      const now = this.#entries();
      now[[...this.memoryList.children].indexOf(row)] = field.value;
      this.drafts.memory = now;
      delete this.refusals.memory;
      row.classList.toggle("bad", entryBreaks(field.value));
      grow();
      this.#updateBudget();
      this.#onChange();
    });
    const remove = button("icb sm xbtn");
    remove.setAttribute("aria-label", names.removeEntry);
    remove.dataset.tip = "";
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      const at = [...this.memoryList.children].indexOf(row);
      const now = this.#entries();
      now.splice(at, 1);
      this.drafts.memory = now;
      delete this.refusals.memory;
      const next = this.memoryList.children[at + 1] ?? this.memoryList.children[at - 1];
      row.remove();
      this.#renumber();
      (
        next?.querySelector("textarea") ?? this.memoryList.parentElement?.querySelector(".addb")
      )?.focus();
      this.#updateBudget();
      this.#onChange();
    });
    row.classList.toggle("bad", entryBreaks(text));
    row.append(field, remove);
    tips(row);
    queueMicrotask(grow);
    return row;
  }

  #renumber() {
    [...this.memoryList.querySelectorAll("textarea")].forEach((field, index) => {
      field.setAttribute("aria-label", this.#files.entry(index + 1));
    });
  }

  /** The budget's bar, its count and what it says; past 80% --warm, over the limit --danger. */
  #updateBudget({ instant = false } = {}) {
    const names = this.#files;
    const entries = this.#entries();
    const { used, limit, over, level } = memoryBudget(entries);
    const refused = ["memory_too_long", "memory_format"].includes(this.refusals.memory);
    this.budget.dataset.level = refused ? "over" : level;
    this.budget.setAttribute("aria-valuemax", String(limit));
    this.budget.setAttribute("aria-valuenow", String(used));
    this.budget.setAttribute("aria-valuetext", names.budget(used, limit));
    this.budgetFill.style.transform = `scaleX(${Math.min(1, used / limit)})`;
    this.budgetNote.textContent = refused
      ? names.refused
      : over > 0
        ? names.overBy(over)
        : entries.some(entryBreaks)
          ? names.entryBreaks
          : names.hermesKeeps(limit);
    // The digits roll at most once a second; the last value always lands.
    const text = names.budget(used, limit);
    this.budgetText = text;
    if (instant) {
      this.budgetCount.replaceChildren(rollText(text));
      this.lastRoll = 0;
      return;
    }
    if (this.rollTimer) return;
    const since = Date.now() - (this.lastRoll ?? 0);
    const run = () => {
      this.rollTimer = null;
      this.lastRoll = Date.now();
      roll(this.budgetCount, this.budgetText);
    };
    if (since >= ROLL_EVERY_MS) run();
    else this.rollTimer = this.#timers.set(run, ROLL_EVERY_MS - since);
  }

  // ── Skills ──────────────────────────────────────────────────────────────────────────────────

  #drawSkills() {
    const box = this.skillsBody;
    if (this.#notReady(box)) return;
    if (this.skillView === "install") {
      box.replaceChildren(this.installer.element);
      return;
    }
    if (this.skillView === "detail" && this.openSkill !== null) {
      box.replaceChildren(this.#skillDetail(this.openSkill));
      return;
    }
    this.skillDetail = null;
    box.replaceChildren(this.#skillList());
  }

  /** The agent's skills, by name and description, with where each came from. */
  #skillList() {
    const names = this.#files;
    const wrap = element("div", "skl-wrap");
    const path = element("p", "path files-path");
    path.textContent = `agents/${this.#agent.id}/skills/`;
    const list = element("div", "skl");
    list.setAttribute("role", "list");
    this.skillRows = list;
    const saved = new Map(this.files.skills.map((skill) => [skill.name, skill]));
    const rows = new Map();
    for (const skill of this.files.skills)
      rows.set(skill.name, { skill, change: this.drafts.skills.get(skill.name) });
    for (const [name, change] of this.drafts.skills) {
      if (!saved.has(name)) rows.set(name, { skill: null, change });
    }
    for (const [name, { skill, change }] of [...rows].sort(([a], [b]) => (a < b ? -1 : 1))) {
      list.append(this.#skillRow(name, skill, change));
    }
    if (rows.size === 0) {
      const empty = element("p", "skl-empty");
      empty.textContent = names.noSkills(this.#agent.name);
      list.append(empty);
    }
    const add = element("div", "skl-add");
    const install = button("btn primary", names.install);
    install.addEventListener("click", () => this.#openInstall());
    const create = button("addb", names.create);
    create.addEventListener("click", () => this.#createSkill());
    add.append(install, create);
    wrap.append(path, list, add);
    return wrap;
  }

  #skillRow(name, skill, change) {
    const names = this.#files;
    const item = element("div", "skl-i");
    item.setAttribute("role", "listitem");
    item.dataset.skill = name;
    const row = button("skl-r");
    const tile = element("span", "skt");
    tile.append(icon("skills"));
    const title = element("b");
    title.textContent = name;
    const description = element("span", "sd");
    const pendingContent = typeof change?.content === "string" ? change.content : null;
    description.textContent = change?.install
      ? change.install.description
      : pendingContent !== null
        ? (skillFields(pendingContent).description ?? "")
        : (skill?.description ?? "");
    const origin = element("span", "so");
    const conflict = this.conflicts[`skill:${name}`];
    const removing = skill !== null && change?.content === null;
    origin.append(
      rollText(
        change?.install
          ? names.pending.install
          : skill === null
            ? names.pending.new
            : removing
              ? names.pending.remove
              : [originLine(skill.origin, names), skill.edited ? names.edited : ""]
                  .filter(Boolean)
                  .join(" · "),
      ),
    );
    row.append(tile, title, description, origin);
    if (conflict || this.refusals[`skill:${name}`]) {
      const alert = element("span", "skl-alert");
      alert.append(icon("alert"));
      row.append(alert);
    }
    if (change?.install || removing) {
      // It opens nothing until it is saved, and stays in the tab order, where Install puts focus.
      row.setAttribute("aria-disabled", "true");
      item.classList.toggle("removing", removing);
      item.append(row, removing ? this.#keepSkill(name) : this.#cancelPending(name));
      tips(item);
      return item;
    }
    row.setAttribute("aria-label", names.openSkill(name));
    row.append(icon("chevronRight"));
    row.addEventListener("click", () => this.#openSkill(name));
    item.append(row, skill === null ? this.#cancelPending(name) : this.#removeSkill(name));
    tips(item);
    return item;
  }

  /** A saved skill goes on Save: ✕ on its row marks it, and keeps an edit to give back. */
  #removeSkill(name) {
    const remove = button("icb sm xbtn");
    remove.setAttribute("aria-label", this.#files.removeSkill(name));
    remove.dataset.tip = "";
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      const edit = this.drafts.skills.get(name);
      this.drafts.skills.set(name, edit ? { content: null, edit } : { content: null });
      this.#marked(name, this.#files.removing(name));
    });
    return remove;
  }

  /** Keep, in the ✕'s place, cancels a removal: the row is back as saved, or as edited. */
  #keepSkill(name) {
    const keep = button("icb sm xbtn");
    keep.setAttribute("aria-label", this.#files.keepSkill(name));
    keep.dataset.tip = "";
    keep.append(icon("undo"));
    keep.addEventListener("click", () => {
      const key = `skill:${name}`;
      const { edit } = this.drafts.skills.get(name) ?? {};
      delete this.refusals[key];
      // A conflict the removal met is the edit's too, which started from the same version; alone,
      // the row shows the vault's version, which a new removal names.
      if (edit) this.drafts.skills.set(name, edit);
      else {
        this.drafts.skills.delete(name);
        delete this.bases[key];
        delete this.conflicts[key];
      }
      this.#marked(name, this.#files.kept(name));
    });
    return keep;
  }

  /**
   * A removal marked or kept: the row changes in place, with focus still in its slot, and the
   * live region says so. Its colors fade and where it came from rolls; from the keyboard, at once.
   */
  #marked(name, said) {
    const rowOf = () => this.skillRows.querySelector(`[data-skill="${CSS.escape(name)}"]`);
    const before = rowOf();
    const was = {
      // The label as it ends: a roll still leaving, from a quick second press, isn't part of it.
      origin: before.querySelector(".so > .roll:last-child").textContent,
      colors: [...before.querySelectorAll(PARTS)].map((part) => getComputedStyle(part).color),
    };
    this.live.textContent = said;
    this.#drawSkills();
    this.#onChange();
    const item = rowOf();
    item.querySelector(".xbtn").focus({ preventScroll: true });
    if (fromKeyboard()) return;
    const origin = item.querySelector(".so");
    const now = origin.textContent;
    origin.replaceChildren(rollText(was.origin));
    roll(origin, now);
    fadeIn(item.querySelector(".xbtn .icon"));
    [...item.querySelectorAll(PARTS)].forEach((part, index) => {
      const { color, textDecorationColor } = getComputedStyle(part);
      play(
        part,
        [
          { color: was.colors[index], textDecorationColor: "transparent" },
          { color, textDecorationColor },
        ],
        { duration: DUR.fade, easing: EASE.fade },
      );
    });
  }

  /** A skill's pending install or new SKILL.md goes, before Save: ✕ on its row. */
  #cancelPending(name) {
    const cancel = button("icb sm xbtn");
    cancel.setAttribute("aria-label", this.#files.cancelPending(name));
    cancel.dataset.tip = "";
    cancel.append(icon("close"));
    cancel.addEventListener("click", () => {
      const rows = [...this.skillRows.querySelectorAll(".skl-i")];
      const at = rows.findIndex((row) => row.dataset.skill === name);
      // The same name installed again is announced again.
      this.live.textContent = "";
      this.drafts.skills.delete(name);
      delete this.bases[`skill:${name}`];
      delete this.conflicts[`skill:${name}`];
      delete this.refusals[`skill:${name}`];
      this.#drawSkills();
      this.#onChange();
      const left = [...this.skillRows.querySelectorAll(".skl-r")];
      const next =
        left[Math.min(at, left.length - 1)] ?? this.skillsBody.querySelector(".skl-add .btn");
      next?.focus({ preventScroll: true });
    });
    return cancel;
  }

  #openSkill(name, { mode } = {}) {
    this.skillView = "detail";
    this.openSkill = name;
    this.#drawSkills();
    if (mode) this.skillDetail?.view.setMode(mode, { keyboard: true, line: 5 });
    this.#onChange();
    this.shown("skills");
    this.skillDetail?.focusTarget?.focus({ preventScroll: true });
  }

  /** "Criar do zero": a new SKILL.md with its frontmatter, open to edit. */
  #createSkill() {
    const names = this.#files.newSkill;
    const taken = new Set([
      ...this.files.skills.map((skill) => skill.name),
      ...this.drafts.skills.keys(),
    ]);
    const name = freeSkillName(names.name, taken);
    this.drafts.skills.set(name, { content: newSkill(name, names.description, names.title) });
    this.#openSkill(name, { mode: "edit" });
  }

  #skillDetail(name) {
    const names = this.#files;
    const saved = this.files.skills.find((skill) => skill.name === name) ?? null;
    const change = this.drafts.skills.get(name);
    const content = typeof change?.content === "string" ? change.content : (saved?.content ?? "");
    const wrap = element("div", "skl-detail");
    const back = button("backb");
    back.append(icon("chevronLeft"), names.back);
    back.addEventListener("click", () => this.#backToList());
    const problem = element("p", "field-error");
    problem.id = "skill-problem";
    const view = this.#fileView(
      "skills",
      `agents/${this.#agent.id}/skills/${name}/SKILL.md`,
      content,
      saved
        ? [originLine(saved.origin, names), saved.edited ? names.edited : ""]
            .filter(Boolean)
            .join(" · ")
        : names.pending.new,
      (text) => {
        let key = this.openSkill;
        // A new skill takes the name its frontmatter gives it, if no other skill has it.
        if (!saved) {
          const fields = skillFields(text);
          const taken =
            this.files.skills.some((skill) => skill.name === fields.name) ||
            (fields.name !== key && this.drafts.skills.has(fields.name));
          if (isSkillName(fields.name) && !taken && fields.name !== key) {
            this.drafts.skills.delete(key);
            // What the old name met, a refusal or a conflict, stays with it.
            for (const kept of [this.bases, this.conflicts, this.refusals])
              delete kept[`skill:${key}`];
            key = fields.name;
            this.openSkill = key;
            view.path.textContent = `agents/${this.#agent.id}/skills/${key}/SKILL.md`;
          }
        }
        this.drafts.skills.set(key, { content: text });
        delete this.refusals[`skill:${key}`];
        this.#showProblem(problem, key, text);
        this.#onChange();
      },
      {
        label: names.fileOf("SKILL.md", name),
        mode: this.skillDetail?.name === name ? this.skillDetail.view.mode : undefined,
      },
    );
    view.input.setAttribute("aria-describedby", problem.id);
    this.#showProblem(problem, name, content);
    const actions = element("div", "skl-actions");
    if (saved?.origin?.kind === "github" && !change) {
      const look = button("btn ghost", names.lookForUpdate);
      this.updateNote = element("p", "files-note");
      this.updateNote.setAttribute("role", "status");
      look.addEventListener("click", () => this.#lookForUpdate(name, look));
      actions.append(look, this.updateNote);
    }
    wrap.append(back, ...this.#banners(`skill:${name}`), view.element, problem, actions);
    this.skillDetail = { name, view, focusTarget: back };
    return wrap;
  }

  #showProblem(line, name, content) {
    const problem = this.#skillProblem(name, content);
    line.hidden = !problem;
    line.replaceChildren(...(problem ? [icon("alert"), problem] : []));
  }

  /** What the vault would refuse in a SKILL.md, in the owner's words, or null. */
  #skillProblem(name, content) {
    const problems = this.#files.skillProblems;
    const fields = skillFields(content);
    if (fields.problem) return problems[fields.problem];
    if (fields.name !== undefined && fields.name !== name) {
      const saved = this.files.skills.some((skill) => skill.name === name);
      return saved ? problems.name_mismatch : problems.taken(fields.name);
    }
    return null;
  }

  #backToList() {
    this.skillView = "list";
    this.openSkill = null;
    this.#drawSkills();
    this.#onChange();
    this.skillRows?.querySelector("button")?.focus({ preventScroll: true });
  }

  async #lookForUpdate(name, look) {
    const names = this.#files;
    look.setAttribute("aria-disabled", "true");
    this.#onMascot("search");
    const result = await this.#io.fetchSkill(this.#agent.id, { update: name });
    look.removeAttribute("aria-disabled");
    if (result.ok) {
      const from = this.files.skills.find((skill) => skill.name === name)?.origin?.commit ?? null;
      this.#openInstall({ staged: result.value.staged, from });
      return;
    }
    const reason = result.value?.reason;
    this.updateNote.textContent =
      reason === "up_to_date"
        ? names.upToDate
        : (names.installing.errors[reason] ?? names.installing.errors.failed);
  }

  #openInstall({ staged, from = null } = {}) {
    this.installer = new SkillInstall({
      names: this.#names,
      blockTexts: this.#blockTexts,
      fetchSkill: (source) => this.#io.fetchSkill(this.#agent.id, source),
      onMascot: this.#onMascot,
      onBack: () => this.#backToList(),
      onInstall: (staged, from) => this.#installed(staged, from),
    });
    this.skillView = "install";
    this.openSkill = null;
    this.#drawSkills();
    if (staged) this.installer.review(staged, { update: from });
    this.#onChange();
    this.shown("skills");
    this.installer.focus();
  }

  /**
   * The owner installed a staged skill: a pending change Save writes. The card folds into a chip,
   * which travels on an arc to the skill's place in the list, and the row pops in (5.7, 5.18).
   */
  #installed(staged, from) {
    this.drafts.skills.set(staged.name, { install: staged });
    // It replaces the version the owner reviewed it against, or none: a newer one is a conflict.
    this.bases[`skill:${staged.name}`] = staged.replaces?.version ?? null;
    this.skillView = "list";
    this.#drawSkills();
    this.#onChange();
    this.#onMascot("approved");
    this.live.textContent = this.#files.installing.added(staged.name);
    const item = this.skillRows.querySelector(`[data-skill="${CSS.escape(staged.name)}"]`);
    item?.querySelector("button")?.focus({ preventScroll: true });
    if (!item || !from || fromKeyboard() || reduced()) {
      if (item && reduced()) play(item, [{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
      return;
    }
    this.#fly(staged.name, from, item);
  }

  #fly(name, from, item) {
    const to = item.getBoundingClientRect();
    const height = to.height;
    // The list opens the gap with --spring-base.
    play(
      item,
      [
        { blockSize: "0px", opacity: 0 },
        { blockSize: `${height}px`, opacity: 0 },
      ],
      {
        ...SPRINGS.base,
        fill: "backwards",
      },
    );
    item.style.opacity = "0";
    const chip = element("span", "chipfly");
    chip.setAttribute("aria-hidden", "true");
    chip.textContent = name;
    document.body.append(chip);
    const x0 = from.left + 12;
    const y0 = from.top + 8;
    const x1 = to.left + 4;
    const y1 = to.top + (height - 28) / 2;
    const cx = (x0 + x1) / 2;
    const cy = Math.min(y0, y1) - 60;
    const frames = [];
    for (let i = 0; i <= 18; i += 1) {
      const t = i / 18;
      const u = 1 - t;
      frames.push({
        transform: `translate(${u * u * x0 + 2 * u * t * cx + t * t * x1}px, ${u * u * y0 + 2 * u * t * cy + t * t * y1}px) scale(${1 - 0.1 * t})`,
        opacity: t > 0.82 ? Math.max(0, 1 - (t - 0.82) / 0.18) : 1,
      });
    }
    const land = () => {
      chip.remove();
      item.style.opacity = "";
      play(item, [{ transform: "scale(1.03)" }, { transform: "none" }], SPRINGS.pop);
    };
    const flight = play(chip, frames, {
      duration: 720,
      easing: "cubic-bezier(0.55, 0, 0.25, 1)",
      fill: "forwards",
    });
    if (flight) flight.finished.then(land, land);
    else land();
  }
}

/** Two lists of memory rows, the same row for row. */
function sameRows(a = [], b = []) {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

/** The I/O the sections use: the files routes, answering `{ ok, value }` or `{ ok: false, status, reason }`. */
export function filesIo(request) {
  return {
    read: (agentId) =>
      request(`/webchat/agents/${encodeURIComponent(agentId)}/files`, { method: "GET" }),
    save: (agentId, changes) =>
      request(`/webchat/agents/${encodeURIComponent(agentId)}/files`, {
        method: "PUT",
        json: { changes },
      }),
    fetchSkill: (agentId, source) => {
      const path = `/webchat/agents/${encodeURIComponent(agentId)}/skills/fetch`;
      if (source.file) {
        return request(`${path}?name=${encodeURIComponent(source.file.name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: source.file,
        });
      }
      return request(path, { method: "POST", json: source });
    },
  };
}
