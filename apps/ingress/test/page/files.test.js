import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../../public/webchat/editor.js";
import { filesIo } from "../../public/webchat/file-sections.js";
import { FileView, rememberedView, VIEW_KEY } from "../../public/webchat/file-view.js";
import { setMotion } from "../../public/webchat/mascot.js";
import { APPROVED_MS } from "../../public/webchat/mascot-states.js";
import { TEXTS } from "../../public/webchat/texts.js";

// The agent's own files in its editor (#381, design system 5.25): Soul, Rules, Memory and Skills,
// read formatted and edited as plain text, saved with the profile and the mascot in one Save, the
// files in one request, so one commit (ADR-0058).

vi.hoisted(() => {
  vi.useFakeTimers({
    now: new Date(2026, 9, 17, 14, 32).getTime(),
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

const T = TEXTS.en;
const F = T.editor.files;
const V = (n) => String(n).repeat(40);
const MASCOT = {
  shape: "mark",
  color: "kelp",
  eyes: "big",
  cheeks: false,
  head: { type: "ears", variation: "round" },
  accessory: { type: "none" },
};
const AGENT = {
  id: "kelpie",
  name: "Kelpie",
  main: true,
  mascot: MASCOT,
  specialty: "",
  remit: "",
};
const SOUL =
  "# Kelpie\n\nYou are Kelpie.\n\n## How it works\n- Asks only when it matters.\n- Confirms first.";
const SKILL = "---\nname: brief\ndescription: Writes a brief.\n---\n\n# Brief\n";
const files = (overrides = {}) => ({
  soul: { content: SOUL, version: V(1) },
  rules: null,
  memory: { content: "Diogo likes mornings.\n§\nAna is in Lisbon.", version: V(2) },
  skills: [
    {
      name: "brief",
      description: "Writes a brief.",
      content: SKILL,
      version: V(3),
      origin: {
        kind: "github",
        owner: "o",
        repo: "skills",
        ref: "main",
        path: "brief",
        commit: V(9),
      },
      edited: false,
    },
  ],
  ...overrides,
});
const STAGED = {
  id: "f".repeat(32),
  name: "pdf-forms",
  description: "Fills PDF forms.",
  origin: {
    kind: "github",
    owner: "exemplo",
    repo: "skills",
    ref: "main",
    path: "pdf-forms",
    commit: "3f2a91c".padEnd(40, "0"),
  },
  files: [
    { path: "SKILL.md", bytes: 120, script: false, binary: false },
    { path: "references/fields.md", bytes: 900, script: false, binary: false },
    { path: "scripts/fill.py", bytes: 13_000, script: true, binary: false },
    { path: "assets/logo.png", bytes: 300, script: false, binary: true },
  ],
  leftOut: [{ path: ".DS_Store", why: "hidden" }],
  skillMd: "---\nname: pdf-forms\ndescription: Fills PDF forms.\n---\n# PDF forms\n",
  bytes: 14_320,
  hash: `sha256:${"a".repeat(64)}`,
  scan: { verdict: "clean", findings: [], more: 0 },
  replaces: null,
};

let editor;
let io;
let sent;
let shown;

function makeIo({ read = { ok: true, status: 200, value: { ok: true, files: files() } } } = {}) {
  sent = [];
  return {
    read: vi.fn(async () => read),
    save: vi.fn(async (_agentId, changes) => {
      sent.push(changes);
      return {
        ok: true,
        status: 200,
        value: {
          ok: true,
          commit: V(7),
          outcomes: changes.map(() => ({ status: "saved", version: V(8) })),
          undo: [{ file: "soul", content: SOUL, version: V(8) }],
          files: files(),
        },
      };
    }),
    fetchSkill: vi.fn(async () => ({ ok: true, status: 200, value: { ok: true, staged: STAGED } })),
  };
}

function make(options) {
  document.body.innerHTML =
    '<div class="app"><div id="row"><span class="avw"><span class="mascot-host"></span><button id="pen" type="button">Edit</button></span></div></div>';
  shown = [];
  io = makeIo(options);
  editor = new Editor({
    texts: T,
    toasts: { show: (toast) => shown.push(toast) },
    onSaved: () => {},
    send: async (_agentId, section, body) => ({
      ok: true,
      value: section === "mascot" ? { mascot: body } : body,
    }),
    files: io,
  });
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const settle = async () => {
  for (let round = 0; round < 30; round += 1) await Promise.resolve();
};
const tab = (name) =>
  $$(".editor-tabs [role='tab']").find((each) => each.textContent.startsWith(name));
const button = (text) => $$("button").find((each) => each.textContent === text);
const key = (target, name, init = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));
const type = (field, value) => {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const open = async () => {
  editor.open(AGENT, { trigger: $("#pen"), from: $("#row"), keyboard: true });
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date(2026, 9, 17, 14, 32).getTime(),
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  setMotion("still");
  localStorage.clear();
  make();
});
afterEach(() => {
  editor.close({ force: true, instant: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reading and editing a file", () => {
  const view = (content = SOUL, mode = "read") => {
    const made = new FileView({
      names: { ...F, blockTexts: T },
      label: "Soul of Kelpie",
      path: "agents/kelpie/SOUL.md",
      content,
      about: "Who it is.",
      mode,
    });
    document.body.append(made.controls, made.element);
    made.mount();
    return made;
  };

  it("opens formatted, through the replies' renderer, with nothing of the file parsed as HTML", () => {
    const shown = view("# Kelpie\n\n<img src=x onerror=alert(1)>");
    expect(shown.view.hidden).toBe(false);
    expect(shown.doc.hidden).toBe(true);
    expect(shown.view.querySelector("img")).toBeNull();
    expect(shown.view.querySelector(".md-h1").textContent).toBe("Kelpie");
    expect(shown.count.textContent).toBe(F.chars("# Kelpie\n\n<img src=x onerror=alert(1)>"));
    expect(shown.path.textContent).toBe("agents/kelpie/SOUL.md");
    expect(view("").view.textContent).toBe(F.emptyFile);
  });

  it("switches with two radio segments, a book and a pencil, and remembers the choice", () => {
    const shown = view();
    const [read, edit] = shown.switch.querySelectorAll("[role='radio']");
    expect(shown.switch.getAttribute("role")).toBe("radiogroup");
    expect([read.getAttribute("aria-label"), edit.getAttribute("aria-label")]).toEqual([
      "View",
      "Edit",
    ]);
    expect([read.dataset.kbd, edit.dataset.kbd]).toEqual(["Ctrl+E", "Ctrl+E"]);
    expect([read.tabIndex, edit.tabIndex]).toEqual([0, -1]);
    edit.click();
    expect(shown.mode).toBe("edit");
    expect(edit.getAttribute("aria-checked")).toBe("true");
    expect(shown.doc.hidden).toBe(false);
    expect(localStorage.getItem(VIEW_KEY)).toBe("edit");
    expect(rememberedView()).toBe("edit");
    // The arrows move and select, as an APG radiogroup.
    key(edit, "ArrowLeft");
    expect(shown.mode).toBe("read");
    expect(document.activeElement).toBe(read);
    key(read, "Enter");
    expect(shown.mode).toBe("read");
  });

  it("edits the plain text, its marks in --muted and the caret's line marked", () => {
    const changes = [];
    const shown = new FileView({
      names: { ...F, blockTexts: T },
      label: "Soul",
      path: "x",
      content: SOUL,
      mode: "edit",
      onInput: (text) => changes.push(text),
    });
    document.body.append(shown.element);
    const lines = [...shown.marks.children];
    expect(lines[0].querySelector(".mk").textContent).toBe("# ");
    expect(lines[0].className).toBe("h");
    expect(lines[4].querySelector(".mk").textContent).toBe("## ");
    expect(lines[5].querySelector(".mk").textContent).toBe("- ");
    expect(lines[2].querySelector(".mk")).toBeNull();
    shown.input.focus();
    shown.input.setSelectionRange(SOUL.indexOf("You"), SOUL.indexOf("You"));
    shown.input.dispatchEvent(new Event("keyup"));
    expect(shown.marks.querySelector(".cur").dataset.line).toBe("2");
    shown.input.dispatchEvent(new Event("blur"));
    expect(shown.marks.querySelector(".cur")).toBeNull();
    type(shown.input, `${SOUL}\n- New.`);
    expect(changes).toEqual([`${SOUL}\n- New.`]);
    expect(shown.marks.children).toHaveLength(8);
    // A fence's lines are code, not marks.
    type(shown.input, "```\n# not a heading\n```");
    expect(shown.marks.children[1].querySelector(".mk")).toBeNull();
    expect(shown.value).toBe("```\n# not a heading\n```");
  });

  it("puts the caret on the line a double-click names, and keeps the place back", () => {
    const shown = view();
    const item = shown.view.querySelectorAll("li")[1];
    item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(shown.mode).toBe("edit");
    expect(shown.input.selectionStart).toBe(SOUL.indexOf("- Confirms"));
    expect(document.activeElement).toBe(shown.input);
    shown.toggle({ keyboard: true });
    expect(shown.mode).toBe("read");
    // The field that had the keys hid: the switch has them now.
    expect(document.activeElement).toBe(shown.radios.read);
  });

  it("keeps the place by a list's item in view, not by the list it is in", () => {
    const shown = view();
    const rect = (top, bottom) => () => ({ top, bottom, left: 0, right: 0, width: 0, height: 0 });
    shown.element.getBoundingClientRect = rect(100, 600);
    for (const node of shown.view.querySelectorAll("[data-line]")) {
      node.getBoundingClientRect = rect(0, 50);
    }
    const [first, second] = shown.view.querySelectorAll("li");
    shown.view.querySelector("ul").getBoundingClientRect = rect(70, 140);
    first.getBoundingClientRect = rect(70, 95);
    second.getBoundingClientRect = rect(110, 140);
    shown.setMode("edit", { keyboard: true });
    expect(shown.input.selectionStart).toBe(SOUL.indexOf("- Confirms"));
  });

  it("keeps working where the browser stores nothing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(rememberedView()).toBe("read");
    const shown = view();
    shown.setMode("edit");
    expect(shown.mode).toBe("edit");
  });
});

describe("the files in the editor", () => {
  it("reads the agent's files when it opens, and says so while it waits", async () => {
    let answer;
    io.read.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    editor.open(AGENT, { trigger: $("#pen"), keyboard: true });
    tab("Soul").click();
    expect($(".files-soul .files-note").textContent).toBe(F.loading);
    answer({ ok: true, status: 200, value: { ok: true, files: files() } });
    await settle();
    expect(io.read).toHaveBeenCalledWith("kelpie");
    expect($(".files-soul .md .md-h1").textContent).toBe("Kelpie");
    expect($(".editor-head .path").textContent).toBe("agents/kelpie/SOUL.md");
    expect($(".editor-head [role='radiogroup']")).not.toBeNull();
    tab("Profile").click();
    expect($(".editor-head [role='radiogroup']")).toBeNull();
  });

  it("says when the vault is off, and offers to read again when a read failed", async () => {
    make({ read: { ok: false, status: 503, value: { reason: "vault_off" } } });
    await open();
    tab("Memory").click();
    expect($(".files-memory").textContent).toBe(F.vaultOff);
    editor.close({ force: true, instant: true });
    make({ read: { ok: false, status: 0, value: null } });
    await open();
    tab("Rules").click();
    expect($(".files-rules").textContent).toContain(F.readFailed);
    io.read.mockResolvedValue({ ok: true, status: 200, value: { ok: true, files: files() } });
    button(F.tryAgain).click();
    await settle();
    expect($(".files-rules").textContent).toContain(F.noRules("Kelpie"));
  });

  it("toggles the shown file with Ctrl+E, and nowhere else", async () => {
    await open();
    tab("Soul").click();
    key($(".files-soul"), "e", { ctrlKey: true });
    expect($(".files-soul .fileview").dataset.mode).toBe("edit");
    key($(".files-soul"), "e", { metaKey: true });
    expect($(".files-soul .fileview").dataset.mode).toBe("read");
    tab("Profile").click();
    const event = new KeyboardEvent("keydown", {
      key: "e",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    $("#editor-name").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps the keys in the editor when Ctrl+E leaves the edit view", async () => {
    await open();
    tab("Soul").click();
    $(".editor-head [role='radio'][aria-label='Edit']").click();
    const input = $(".files-soul .doc-input");
    input.focus();
    key(input, "e", { ctrlKey: true });
    expect($(".files-soul .fileview").dataset.mode).toBe("read");
    expect(document.activeElement).toBe($(".editor-head [role='radio'][aria-label='View']"));
    key(document.activeElement, "e", { ctrlKey: true });
    expect($(".files-soul .fileview").dataset.mode).toBe("edit");
  });

  it("keeps the focus and the caret in an open SKILL.md through a save", async () => {
    await open();
    tab("Skills").click();
    $(".skl-r").click();
    key($(".files-skills"), "e", { ctrlKey: true });
    const input = $(".files-skills .doc-input");
    expect(input.getAttribute("aria-label")).toBe(F.fileOf("SKILL.md", "brief"));
    type(input, SKILL.replace("Writes a brief.", "Writes briefs."));
    input.focus();
    input.setSelectionRange(5, 5);
    await editor.save();
    const now = $(".files-skills .doc-input");
    expect(document.activeElement).toBe(now);
    expect(now.selectionStart).toBe(5);
    expect($(".files-skills .fileview").dataset.mode).toBe("edit");
  });

  it("gives focus back to the section's tab when a save redraws what had it", async () => {
    await open();
    tab("Skills").click();
    $(".skl-r").click();
    key($(".files-skills"), "e", { ctrlKey: true });
    const input = $(".files-skills .doc-input");
    type(input, SKILL.replace("Writes a brief.", "Writes briefs."));
    input.focus();
    key(input, "e", { ctrlKey: true });
    expect(document.activeElement.getAttribute("aria-label")).toBe("View");
    await editor.save();
    expect(document.activeElement).toBe(tab("Skills"));
  });

  it("leaves focus where the owner took it while a save was on its way", async () => {
    await open();
    tab("Skills").click();
    $(".skl-r").click();
    key($(".files-skills"), "e", { ctrlKey: true });
    type($(".files-skills .doc-input"), SKILL.replace("Writes a brief.", "Writes briefs."));
    let answer;
    io.save.mockImplementationOnce(
      (_agentId, changes) =>
        new Promise((resolve) => {
          sent.push(changes);
          answer = resolve;
        }),
    );
    const saving = editor.save();
    const composer = document.createElement("textarea");
    $(".app").append(composer);
    composer.focus();
    answer({
      ok: true,
      status: 200,
      value: {
        ok: true,
        commit: V(7),
        outcomes: [{ status: "saved", version: V(8) }],
        undo: [],
        files: files(),
      },
    });
    await saving;
    expect(document.activeElement).toBe(composer);
  });

  it("keeps the keys in the editor when Retry fails again", async () => {
    await open();
    tab("Memory").click();
    type($$(".files-memory .mem-t")[0], "Diogo likes early mornings.");
    io.save.mockResolvedValue({ ok: false, status: 0, value: null });
    await editor.save();
    const retry = button(T.editor.retry.memory);
    retry.focus();
    retry.click();
    await settle();
    expect($(".editor").contains(document.activeElement)).toBe(true);
  });

  it("saves the soul with the version it read, in one request beside the profile", async () => {
    await open();
    tab("Soul").click();
    $(".editor-head [role='radio'][aria-label='Edit']").click();
    type($(".files-soul .doc-input"), `${SOUL}\n- Signs off.`);
    expect(tab("Soul").getAttribute("aria-label")).toBe("Soul, changed");
    tab("Profile").click();
    type($("#editor-remit"), "Runs the day.");
    expect($(".dirty").textContent).toBe("2 unsaved changes");
    await editor.save();
    expect(sent).toEqual([[{ file: "soul", content: `${SOUL}\n- Signs off.`, version: V(1) }]]);
    expect($(".save").dataset.state).toBe("done");
    vi.advanceTimersByTime(APPROVED_MS);
    expect(shown[0].text).toBe("Kelpie: profile and soul saved");
    // Undo writes the previous version back, from the version this save wrote.
    await shown[0].action.run();
    expect(sent.at(-1)).toEqual([{ file: "soul", content: SOUL, version: V(8) }]);
    expect(shown.at(-1)).toEqual({ text: T.editor.undone("Kelpie") });
  });

  it("keeps what the owner typed while it saved, to save next on the version just written", async () => {
    await open();
    tab("Soul").click();
    $(".editor-head [role='radio'][aria-label='Edit']").click();
    const input = $(".files-soul .doc-input");
    type(input, "# One");
    let answer;
    io.save.mockImplementationOnce(
      (_agentId, changes) =>
        new Promise((resolve) => {
          sent.push(changes);
          answer = resolve;
        }),
    );
    const saving = editor.save();
    type(input, "# One and two");
    answer({
      ok: true,
      status: 200,
      value: {
        ok: true,
        commit: V(7),
        outcomes: [{ status: "saved", version: V(8) }],
        undo: [],
        files: files({ soul: { content: "# One", version: V(8) } }),
      },
    });
    await saving;
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("# One and two");
    expect($(".dirty").textContent).toBe("1 unsaved change");
    await editor.save();
    expect(sent[1]).toEqual([{ file: "soul", content: "# One and two", version: V(8) }]);
  });

  it("creates the agent's own rules from the empty state", async () => {
    await open();
    tab("Rules").click();
    expect($(".files-empty b").textContent).toBe(F.noRules("Kelpie"));
    button(F.createRules).click();
    const input = $(".files-rules .doc-input");
    expect(input.value).toBe(F.rulesStart("Kelpie"));
    expect($(".files-rules .fileview").dataset.mode).toBe("edit");
    await editor.save();
    expect(sent[0]).toEqual([{ file: "rules", content: F.rulesStart("Kelpie"), version: null }]);
  });

  it("keeps the draft on a conflict, shows the vault's version, and saves over it only when kept", async () => {
    await open();
    tab("Soul").click();
    $(".editor-head [role='radio'][aria-label='Edit']").click();
    type($(".files-soul .doc-input"), "# Mine");
    // The vault holds a newer version, until a save names it.
    io.save.mockImplementation(async (_agentId, changes) => {
      sent.push(changes);
      const newer = changes[0].version !== V(5);
      return {
        ok: true,
        status: 200,
        value: {
          ok: true,
          commit: newer ? null : V(6),
          outcomes: [
            newer
              ? { status: "conflict", current: { content: "# Theirs", version: V(5) } }
              : { status: "saved", version: V(6) },
          ],
          undo: [],
          files: files({
            soul: { content: newer ? "# Theirs" : "# Mine", version: newer ? V(5) : V(6) },
          }),
        },
      };
    });
    await editor.save();
    expect($(".editor-foot").textContent).toContain(T.editor.failed.soul);
    expect($(".editor-foot").textContent).toContain(F.conflict.title);
    expect($(".files-soul .files-conflict b").textContent).toBe(F.conflict.title);
    expect($(".files-soul .doc-input").value).toBe("# Mine");
    button(F.conflict.show).click();
    expect($(".files-soul .files-theirs").textContent).toBe("# Theirs");
    // Saving again names the version the draft started from: still a conflict, never an overwrite.
    await editor.save();
    expect(sent[1]).toEqual([{ file: "soul", content: "# Mine", version: V(1) }]);
    button(F.conflict.keep).click();
    expect($(".files-soul .files-conflict").textContent).toContain(F.conflict.kept);
    await editor.save();
    expect(sent[2]).toEqual([{ file: "soul", content: "# Mine", version: V(5) }]);
    expect($(".save").dataset.state).toBe("done");
  });

  it("takes the vault's version when the owner asks", async () => {
    await open();
    tab("Soul").click();
    $(".editor-head [role='radio'][aria-label='Edit']").click();
    type($(".files-soul .doc-input"), "# Mine");
    io.save.mockResolvedValueOnce({
      ok: true,
      status: 200,
      value: {
        ok: true,
        commit: null,
        outcomes: [{ status: "conflict", current: null }],
        undo: [],
        files: files({ soul: null }),
      },
    });
    await editor.save();
    expect($(".files-soul .files-conflict").textContent).toContain(F.conflict.gone);
    button(F.conflict.take).click();
    expect($(".files-soul .files-conflict")).toBeNull();
    expect($(".dirty").textContent).toBe(T.editor.allSaved);
  });

  it("names a save that failed in part, and what the vault refused", async () => {
    await open();
    tab("Mascot").click();
    $$("[role='radiogroup'][aria-label='Shape'] [role='radio']")[1].click();
    tab("Memory").click();
    type($$(".files-memory .mem-t")[0], "Diogo likes mornings, and coffee.");
    io.save.mockResolvedValueOnce({
      ok: true,
      status: 200,
      value: {
        ok: true,
        commit: null,
        outcomes: [{ status: "refused", reason: "memory_too_long" }],
        undo: [],
        files: files(),
      },
    });
    await editor.save();
    const foot = $(".editor-foot");
    expect(foot.getAttribute("role")).toBe("alert");
    expect(foot.textContent).toContain(T.editor.failed.memory);
    expect(foot.textContent).toContain(
      `${T.editor.stillSaved.mascot} ${F.refusals.memory_too_long}`,
    );
    expect(button(T.editor.retry.memory)).not.toBeUndefined();
    expect($(".budget").dataset.level).toBe("over");
    expect($(".budget-note").textContent).toBe(F.refused);
    expect(tab("Memory").getAttribute("aria-label")).toBe("Memory, not saved");
  });

  it("says nothing was saved when the files' request failed, and names several sections", async () => {
    await open();
    tab("Soul").click();
    $(".editor-head [role='radio'][aria-label='Edit']").click();
    type($(".files-soul .doc-input"), "# Mine");
    tab("Memory").click();
    button(F.addEntry).click();
    type($$(".files-memory .mem-t").at(-1), "New one.");
    io.save.mockResolvedValueOnce({ ok: false, status: 0, value: null });
    await editor.save();
    expect($(".editor-foot b").textContent).toBe(T.editor.failed.both);
    expect(button(T.editor.retry.both)).not.toBeUndefined();
    tab("Mascot").click();
    $$("[role='radiogroup'][aria-label='Shape'] [role='radio']")[1].click();
    io.save.mockResolvedValueOnce({ ok: false, status: 0, value: null });
    await editor.save();
    expect($(".editor-foot b").textContent).toBe(
      T.editor.failedMany(["soul", "memory"], T.editor.sections),
    );
  });
});

describe("the memory", () => {
  it("shows one row per entry, and keeps Hermes's format when entries come and go", async () => {
    await open();
    tab("Memory").click();
    const rows = () => $$(".files-memory .mem-t");
    expect(rows().map((row) => row.value)).toEqual(["Diogo likes mornings.", "Ana is in Lisbon."]);
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Memory 1", "Memory 2"]);
    expect($(".path.files-path").textContent).toBe("agents/kelpie/memories/MEMORY.md");
    button(F.addEntry).click();
    expect(document.activeElement).toBe(rows()[2]);
    type(rows()[2], "  Meet for external calls. ");
    $$(".files-memory .xbtn")[0].click();
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Memory 1", "Memory 2"]);
    await editor.save();
    expect(sent[0]).toEqual([
      { file: "memory", content: "Ana is in Lisbon.\n§\nMeet for external calls.", version: V(2) },
    ]);
  });

  it("shows the rows as saved after a save that left an emptied one out", async () => {
    await open();
    tab("Memory").click();
    const rows = () => $$(".files-memory .mem-t");
    type(rows()[0], "");
    io.save.mockImplementationOnce(async (_agentId, changes) => {
      sent.push(changes);
      return {
        ok: true,
        status: 200,
        value: {
          ok: true,
          commit: V(7),
          outcomes: [{ status: "saved", version: V(8) }],
          undo: [],
          files: files({ memory: { content: "Ana is in Lisbon.", version: V(8) } }),
        },
      };
    });
    await editor.save();
    expect(rows().map((row) => row.value)).toEqual(["Ana is in Lisbon."]);
    type(rows()[0], "Ana is in Lisbon this week.");
    await editor.save();
    expect(sent[1]).toEqual([
      { file: "memory", content: "Ana is in Lisbon this week.", version: V(8) },
    ]);
  });

  it("counts its budget, turns --warm past 80%, and holds Save over the limit", async () => {
    await open();
    tab("Memory").click();
    const meter = $(".budget");
    expect(meter.getAttribute("role")).toBe("meter");
    expect(meter.getAttribute("aria-valuemax")).toBe("2200");
    expect(meter.getAttribute("aria-valuenow")).toBe("41");
    expect($(".budget-count").textContent).toBe(F.budget(41, 2_200));
    expect($(".budget-note").textContent).toBe(F.hermesKeeps(2_200));
    const [first] = $$(".files-memory .mem-t");
    type(first, "x".repeat(1_800));
    expect(meter.dataset.level).toBe("near");
    // The digits roll at most once a second, and the last value lands.
    vi.advanceTimersByTime(1_000);
    expect($(".budget-count .roll:last-child").textContent).toBe(F.budget(1_820, 2_200));
    type(first, "x".repeat(2_300));
    expect(meter.dataset.level).toBe("over");
    expect($(".budget-note").textContent).toBe(F.overBy(2_300 + 20 - 2_200));
    expect($(".save").getAttribute("aria-disabled")).toBe("true");
    await editor.save();
    expect(sent).toEqual([]);
    expect(tab("Memory").getAttribute("aria-selected")).toBe("true");
  });

  it("flags an entry Hermes would split", async () => {
    await open();
    tab("Memory").click();
    const [first] = $$(".files-memory .mem-t");
    type(first, "one\n§\ntwo");
    expect(first.closest(".mem-e").classList.contains("bad")).toBe(true);
    expect($(".budget-note").textContent).toBe(F.entryBreaks);
    expect($(".save").getAttribute("aria-disabled")).toBe("true");
  });

  it("says when there are no memories yet", async () => {
    make({ read: { ok: true, status: 200, value: { ok: true, files: files({ memory: null }) } } });
    await open();
    tab("Memory").click();
    expect($(".mems-empty").textContent).toBe(F.noMemories);
    button(F.addEntry).click();
    expect($(".mems-empty")).toBeNull();
  });
});

describe("the skills", () => {
  it("lists them by name and description, with where each came from", async () => {
    await open();
    tab("Skills").click();
    const row = $(".skl-r");
    expect(row.querySelector("b").textContent).toBe("brief");
    expect(row.querySelector(".sd").textContent).toBe("Writes a brief.");
    expect(row.querySelector(".so").textContent).toBe(`o/skills · ${"9".repeat(7)}`);
    expect(row.getAttribute("aria-label")).toBe(F.openSkill("brief"));
    expect($(".editor-title").textContent).toBe("Skills");
  });

  it("opens a SKILL.md, edits it, checks its name, and saves it", async () => {
    await open();
    tab("Skills").click();
    $(".skl-r").click();
    expect($(".editor-title").textContent).toBe("brief");
    expect($(".editor-head .path").textContent).toBe("agents/kelpie/skills/brief/SKILL.md");
    key($(".files-skills"), "e", { ctrlKey: true });
    const input = $(".files-skills .doc-input");
    type(input, SKILL.replace("name: brief", "name: other"));
    expect($("#skill-problem").textContent).toBe(F.skillProblems.name_mismatch);
    expect($(".save").getAttribute("aria-disabled")).toBe("true");
    type(input, SKILL.replace("Writes a brief.", "Writes briefs."));
    expect($("#skill-problem").hidden).toBe(true);
    await editor.save();
    expect(sent[0]).toEqual([
      {
        file: "skill",
        name: "brief",
        content: SKILL.replace("Writes a brief.", "Writes briefs."),
        version: V(3),
      },
    ]);
  });

  it("looks for an update, and says when it is up to date", async () => {
    await open();
    tab("Skills").click();
    $(".skl-r").click();
    io.fetchSkill.mockResolvedValueOnce({
      ok: false,
      status: 422,
      value: { ok: false, reason: "up_to_date" },
    });
    button(F.lookForUpdate).click();
    await settle();
    expect(io.fetchSkill).toHaveBeenCalledWith("kelpie", { update: "brief" });
    expect($(".skl-actions .files-note").textContent).toBe(F.upToDate);
    io.fetchSkill.mockResolvedValueOnce({
      ok: true,
      status: 200,
      value: {
        ok: true,
        staged: {
          ...STAGED,
          name: "brief",
          replaces: {
            version: V(3),
            edited: true,
            changes: [{ path: "SKILL.md", change: "changed" }],
            diff: [
              { op: "=", text: "# Brief" },
              { op: "-", text: "old" },
              { op: "+", text: "new" },
            ],
          },
        },
      },
    });
    button(F.lookForUpdate).click();
    await settle();
    expect($(".editor-title").textContent).toBe(F.install);
    expect($(".rev-replaces").textContent).toBe(F.installing.replaces("brief"));
    expect($(".rev .src").textContent).toContain(F.installing.update("9999999", "3f2a91c"));
    expect($(".rev-warn").textContent).toBe(F.installing.editedWarning);
    expect($(".rev-changes .tag").textContent).toBe(F.installing.changes.changed);
    expect($(".rev-diff .del").textContent).toBe("- old\n");
  });

  it("leaves YAML it can't read for sure to the vault", async () => {
    await open();
    tab("Skills").click();
    $(".skl-r").click();
    key($(".files-skills"), "e", { ctrlKey: true });
    type($(".files-skills .doc-input"), SKILL.replace("name: brief", "name: 'brief' # the skill"));
    expect($("#skill-problem").hidden).toBe(true);
    await editor.save();
    expect(sent[0]).toMatchObject([{ file: "skill", name: "brief" }]);
  });

  it("creates one from scratch, which takes the name its frontmatter gives it", async () => {
    await open();
    tab("Skills").click();
    button(F.create).click();
    expect($(".files-skills .fileview").dataset.mode).toBe("edit");
    const input = $(".files-skills .doc-input");
    expect(input.value).toBe(
      `---\nname: new-skill\ndescription: ${F.newSkill.description}\n---\n\n# New skill\n\n`,
    );
    type(input, input.value.replace("name: new-skill", "name: morning-brief"));
    expect($(".editor-head .path").textContent).toBe("agents/kelpie/skills/morning-brief/SKILL.md");
    type(input, input.value.replace("name: morning-brief", "name: brief"));
    expect($("#skill-problem").textContent).toBe(F.skillProblems.taken("brief"));
    type(input, input.value.replace("name: brief", "name: morning-brief"));
    $(".backb").click();
    expect($$(".skl-r b").map((name) => name.textContent)).toEqual(["brief", "morning-brief"]);
    await editor.save();
    expect(sent[0]).toMatchObject([{ file: "skill", name: "morning-brief", version: null }]);
  });
});

describe("a pending skill", () => {
  it("leaves what the old name met behind when a new skill takes another", async () => {
    await open();
    tab("Skills").click();
    button(F.create).click();
    io.save.mockImplementationOnce(async (_agentId, changes) => {
      sent.push(changes);
      return {
        ok: true,
        status: 200,
        value: {
          ok: true,
          commit: null,
          outcomes: [{ status: "refused", reason: "taken" }],
          undo: [],
          files: files(),
        },
      };
    });
    await editor.save();
    expect($(".files-skills .files-refused").textContent).toBe(F.refusals.taken);
    const input = $(".files-skills .doc-input");
    type(input, input.value.replace("name: new-skill", "name: my-skill"));
    $(".backb").click();
    button(F.create).click();
    expect($(".editor-title").textContent).toBe("new-skill");
    expect($(".files-skills .files-refused")).toBeNull();
  });

  it("keeps a new skill's name while its frontmatter is gone", async () => {
    await open();
    tab("Skills").click();
    button(F.create).click();
    type($(".files-skills .doc-input"), "");
    expect($(".editor-head .path").textContent).toBe("agents/kelpie/skills/new-skill/SKILL.md");
    expect($("#skill-problem").textContent).toBe(F.skillProblems.frontmatter);
    $(".backb").click();
    const row = $$(".skl-r").find((each) => each.querySelector("b").textContent === "new-skill");
    row.click();
    expect($(".editor-title").textContent).toBe("new-skill");
  });

  it("cancels a pending new skill or install from its row", async () => {
    await open();
    tab("Skills").click();
    button(F.create).click();
    $(".backb").click();
    const cancel = $(`[aria-label="${F.cancelPending("new-skill")}"]`);
    cancel.click();
    expect($$(".skl-r b").map((name) => name.textContent)).toEqual(["brief"]);
    expect(document.activeElement).toBe($(".skl-r"));
    expect(tab("Skills").getAttribute("aria-label")).toBe("Skills");
  });
});

describe("installing a skill", () => {
  const installView = async () => {
    await open();
    tab("Skills").click();
    button(F.install).click();
  };
  const I = F.installing;

  it("fetches from a GitHub address, then shows what it staged for review", async () => {
    await installView();
    expect($(".editor-title").textContent).toBe(F.install);
    const radios = $$(".inst-seg [role='radio']");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      I.source.github,
      I.source.archive,
      I.source.text,
    ]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    const address = $(".inst .field .txt");
    address.value = "github.com/exemplo/skills/tree/main/pdf-forms";
    let answer;
    io.fetchSkill.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    $(".get").click();
    expect($(".get").classList.contains("busy")).toBe(true);
    expect($(".phase .roll:last-child").textContent).toBe(I.fetching("exemplo/skills"));
    answer({ ok: true, status: 200, value: { ok: true, staged: STAGED } });
    await settle();
    expect(io.fetchSkill).toHaveBeenCalledWith("kelpie", {
      github: "github.com/exemplo/skills/tree/main/pdf-forms",
    });
    expect($(".get").classList.contains("ok")).toBe(true);
    expect($(".phase .roll:last-child").textContent).toBe(I.checked(4, "3f2a91c"));
    const card = $(".rev");
    expect(card.querySelector(".rev-h b").textContent).toBe("pdf-forms");
    expect(card.querySelector(".src").textContent).toBe(
      `exemplo/skills · 3f2a91c · ${I.files(4, "14 KB")}`,
    );
    expect($$(".rev .files .tag").map((tag) => tag.textContent)).toEqual([I.script, I.binary]);
    expect(card.querySelector(".rev-left").textContent).toBe(I.leftOut(1));
    // A branch vouches for this commit; one named in the address alone would say it isn't checked.
    expect(card.querySelector(".rev-pin")).toBeNull();
    expect(card.querySelector(".scan").textContent).toBe(I.verdict.clean);
    button(I.showSkillMd).click();
    expect(card.querySelector(".rev-md").hidden).toBe(false);
    expect(card.querySelector(".rev-md .md-h1").textContent).toBe("PDF forms");
    button(I.hideSkillMd).click();
    expect(card.querySelector(".rev-md").hidden).toBe(true);
  });

  it("says a commit named in the address alone isn't checked against the repository", async () => {
    await installView();
    const commit = STAGED.origin.commit;
    io.fetchSkill.mockResolvedValueOnce({
      ok: true,
      status: 200,
      value: { ok: true, staged: { ...STAGED, origin: { ...STAGED.origin, ref: commit } } },
    });
    $(".inst .field .txt").value = `github.com/exemplo/skills/tree/${commit}/pdf-forms`;
    $(".get").click();
    await settle();
    expect($(".rev .rev-pin").textContent).toBe(I.pinnedCommit);
  });

  it("installs it as a pending change Save writes, and says so", async () => {
    await installView();
    $(".inst .field .txt").value = "github.com/exemplo/skills";
    key($(".inst .field .txt"), "Enter");
    await settle();
    $(".rev .ib").click();
    expect($(".rev .ib .roll:last-child").textContent).toBe(I.button.busy);
    await settle();
    expect($(".editor-title").textContent).toBe("Skills");
    const row = $$(".skl-r").find((each) => each.querySelector("b").textContent === "pdf-forms");
    expect(row.querySelector(".so").textContent).toBe(F.pending.install);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(row);
    // The announcement sits outside the list the install redrew, so it is heard.
    expect($(".files-skills > [aria-live='polite']").textContent).toBe(I.added("pdf-forms"));
    expect(tab("Skills").getAttribute("aria-label")).toBe("Skills, changed");
    await editor.save();
    expect(sent[0]).toEqual([
      { file: "install", staged: STAGED.id, hash: STAGED.hash, version: null },
    ]);
  });

  it("reviews pasted text and an uploaded file", async () => {
    await installView();
    const [, archive, text] = $$(".inst-seg [role='radio']");
    text.click();
    expect($(".paste").hidden).toBe(false);
    button(I.review).click();
    expect(io.fetchSkill).not.toHaveBeenCalled();
    type($(".paste-t"), STAGED.skillMd);
    button(I.review).click();
    await settle();
    expect(io.fetchSkill).toHaveBeenLastCalledWith("kelpie", { text: STAGED.skillMd });
    archive.click();
    expect($(".rev")).toBeNull();
    const file = new File([new Uint8Array([80, 75])], "pdf.skill");
    const input = $(".drop input[type='file']");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await settle();
    expect(io.fetchSkill).toHaveBeenLastCalledWith("kelpie", { file });
    // A file dropped on the pane installs from the file too.
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
    $(".inst").dispatchEvent(drop);
    await settle();
    expect(io.fetchSkill).toHaveBeenCalledTimes(3);
    // The arrows move between the sources.
    key($(".inst-seg"), "ArrowRight");
    expect($$(".inst-seg [role='radio']")[2].getAttribute("aria-checked")).toBe("true");
  });

  it("keeps errors in the card, and the input as it was", async () => {
    await installView();
    const address = $(".inst .field .txt");
    button(I.fetch);
    $(".get").click();
    expect(io.fetchSkill).not.toHaveBeenCalled();
    address.value = "github.com/o/r";
    for (const [value, text] of [
      [{ reason: "many_skills", names: ["a", "b"] }, I.errors.many_skills("a, b")],
      [{ reason: "no_skill" }, I.errors.no_skill(I.where.github)],
      [{ reason: "too_large" }, I.errors.too_large(null)],
      [{ reason: "link", detail: "evil" }, I.errors.link("evil")],
      [{ reason: "nested_skill", detail: "a/SKILL.md" }, I.errors.nested_skill("a/SKILL.md")],
      [{ reason: "path_clash", detail: "README.md" }, I.errors.path_clash("README.md")],
      [{ reason: "not_text", detail: "x.md" }, I.errors.not_text("x.md")],
      [{ reason: "invalid_skill", detail: "name" }, F.skillProblems.name],
      [{ reason: "invalid_skill", detail: "name_mismatch" }, I.errors.name_mismatch],
      [{ reason: "vault_off" }, F.vaultOff],
      [{ reason: "whatever" }, I.errors.failed],
    ]) {
      io.fetchSkill.mockResolvedValueOnce({ ok: false, status: 422, value: value });
      $(".get").click();
      await settle();
      expect($(".inst-error").textContent).toBe(text);
      expect(address.value).toBe("github.com/o/r");
      expect($(".get").classList.contains("busy")).toBe(false);
    }
  });

  it("says why a blocked skill can't install, and lists the findings by file and line", async () => {
    await installView();
    io.fetchSkill.mockResolvedValueOnce({
      ok: true,
      status: 200,
      value: {
        ok: true,
        staged: {
          ...STAGED,
          origin: { kind: "archive", filename: "pdf.zip" },
          scan: {
            verdict: "blocked",
            findings: [
              { path: "SKILL.md", line: 4, kind: "hidden_characters", excerpt: "a⟨U+200B⟩b" },
              { path: "tool.exe", line: 0, kind: "executable", excerpt: "" },
            ],
            more: 2,
          },
        },
      },
    });
    $(".inst .field .txt").value = "github.com/o/r";
    $(".get").click();
    await settle();
    expect($(".scan").textContent).toBe(I.verdict.blocked);
    expect($$(".findings li").map((item) => item.textContent)).toEqual([
      `${I.at("SKILL.md", 4)}${I.kinds.hidden_characters}a⟨U+200B⟩b`,
      `tool.exe${I.kinds.executable}`,
      I.more(2),
    ]);
    expect($(".rev .ib")).toBeNull();
    expect($(".rev .src").textContent).toContain(F.origins.archive);
  });

  it("counts a caution's findings", async () => {
    await installView();
    io.fetchSkill.mockResolvedValueOnce({
      ok: true,
      status: 200,
      value: {
        ok: true,
        staged: {
          ...STAGED,
          scan: {
            verdict: "caution",
            findings: [{ path: "s.sh", line: 2, kind: "privilege", excerpt: "sudo ls" }],
            more: 0,
          },
        },
      },
    });
    $(".inst .field .txt").value = "github.com/o/r";
    $(".get").click();
    await settle();
    expect($(".scan").textContent).toBe(I.verdict.caution(1));
    $(".inst .backb").click();
    expect($(".editor-title").textContent).toBe("Skills");
  });
});

describe("the files' routes", () => {
  it("reads, saves and stages through the editor's routes", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const routes = filesIo(request);
    await routes.read("kelpie");
    await routes.save("kelpie", [{ file: "soul" }]);
    await routes.fetchSkill("kelpie", { github: "github.com/o/r" });
    const file = new File(["x"], "a b.zip");
    await routes.fetchSkill("kelpie", { file });
    expect(request.mock.calls).toEqual([
      ["/webchat/agents/kelpie/files", { method: "GET" }],
      ["/webchat/agents/kelpie/files", { method: "PUT", json: { changes: [{ file: "soul" }] } }],
      [
        "/webchat/agents/kelpie/skills/fetch",
        { method: "POST", json: { github: "github.com/o/r" } },
      ],
      [
        "/webchat/agents/kelpie/skills/fetch?name=a%20b.zip",
        { method: "POST", headers: { "Content-Type": "application/zip" }, body: file },
      ],
    ]);
  });

  it("sends them same-origin, and reads the answer's reasons", async () => {
    make();
    const fetch = vi.fn(async () =>
      Response.json({ ok: false, reason: "vault_off" }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);
    const real = new Editor({ texts: T, toasts: { show: () => {} }, onSaved: () => {} });
    real.open(AGENT, { trigger: $("#pen"), keyboard: true });
    await settle();
    expect(fetch).toHaveBeenCalledWith(
      "/webchat/agents/kelpie/files",
      expect.objectContaining({ method: "GET", redirect: "manual", cache: "no-store" }),
    );
    tab("Soul").click();
    expect($(".files-soul").textContent).toBe(F.vaultOff);
    real.close({ force: true, instant: true });
    vi.unstubAllGlobals();
  });
});
