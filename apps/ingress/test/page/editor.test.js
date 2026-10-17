import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, SAVE_TIMEOUT_MS } from "../../public/webchat/editor.js";
import { setMotion } from "../../public/webchat/mascot.js";
import { APPROVED_MS } from "../../public/webchat/mascot-states.js";
import { TEXTS } from "../../public/webchat/texts.js";
import { UNDO_TOAST_MS } from "../../public/webchat/toasts.js";

// The agent's editor (#379, design system 5.25): opened from the pencil on a mascot, its sections
// on the left, Profile and Mascot working and the agent's own files disabled until #381, and one
// Save that writes each changed section once, through its own route.

vi.hoisted(() => {
  // Before mascot.js loads, so the one timer it starts for every mascot is a fake one too.
  vi.useFakeTimers({
    now: new Date(2026, 9, 16, 14, 32).getTime(),
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

const T = TEXTS.en;
const KELPIE = {
  shape: "mark",
  color: "kelp",
  eyes: "big",
  cheeks: false,
  head: { type: "ears", variation: "round" },
  accessory: { type: "none" },
};
const AGENDA = {
  id: "agenda",
  name: "Agenda",
  main: false,
  mascot: { ...KELPIE, color: "fawn", shape: "pebble" },
  specialty: "Agenda e e-mail",
  remit: "Books meetings.",
};
const MAIN = { id: "kelpie", name: "Kelpie", main: true, mascot: KELPIE, specialty: "", remit: "" };

let editor;
let sent;
let saved;
let shown;
let expired;
let answers;

function make() {
  document.body.innerHTML =
    '<div class="app"><div id="row"><span class="avw"><span class="mascot-host"></span><button id="pen" type="button">Edit</button></span></div><button id="switcher" type="button">Agents</button></div>';
  sent = [];
  saved = [];
  shown = [];
  expired = vi.fn();
  answers = {};
  editor = new Editor({
    texts: T,
    toasts: { show: (toast) => shown.push(toast) },
    onSaved: (agentId, changes) => saved.push([agentId, changes]),
    onExpired: expired,
    // The agent's own files have tests of their own (files.test.js): here, a vault that is off.
    files: {
      read: async () => ({ ok: false, status: 503, value: { reason: "vault_off" } }),
      save: async () => ({ ok: false, status: 503, value: { reason: "vault_off" } }),
      fetchSkill: async () => ({ ok: false, status: 503, value: { reason: "vault_off" } }),
    },
    send: async (agentId, section, body) => {
      sent.push({ agentId, section, body });
      const answer = answers[section];
      if (answer) return await answer;
      return { ok: true, value: section === "mascot" ? { mascot: body } : body };
    },
  });
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pen = () => document.getElementById("pen");
const open = (agent = AGENDA, how = {}) =>
  editor.open(agent, { trigger: pen(), from: document.getElementById("row"), ...how });
const tab = (name) =>
  $$(".editor-tabs [role='tab']").find((each) => each.textContent.startsWith(name));
const radios = (label) => [
  ...$(`[role='radiogroup'][aria-label='${label}']`).querySelectorAll("[role='radio']"),
];
/** A radio's name: its tile's figure is hidden from screen readers. */
const nameOf = (radio) => radio.querySelector(".opt-name").textContent;
/** What the Save button says now: a suffix that rolled out may still be leaving. */
const saveLabel = () =>
  `${$(".save .stem").textContent}${$(".save .suffix .roll:last-child").textContent}`;
const checked = (label) =>
  radios(label).find((radio) => radio.getAttribute("aria-checked") === "true");
const key = (target, name, init = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));
const point = () => window.dispatchEvent(new PointerEvent("pointerdown"));
const settle = async () => {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
};
const footer = () => $(".editor-foot");
const button = (text) =>
  [...document.querySelectorAll("button")].find((each) => each.textContent === text);

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date(2026, 9, 16, 14, 32).getTime(),
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  setMotion("still");
  make();
});
afterEach(() => {
  editor.close({ force: true, instant: true });
  // A test that fails halfway leaves no stub behind for the next.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("opening the editor", () => {
  it("opens on its Mascot section, a panel the conversation stays live beside", () => {
    open();
    const panel = $("#editor");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-label")).toBe("Edit Agenda");
    expect(panel.hasAttribute("aria-modal")).toBe(false);
    expect($(".app").inert).toBeFalsy();
    expect(pen().getAttribute("aria-expanded")).toBe("true");
    expect(editor.agentId).toBe("agenda");
    // The agent, on the left: its mascot at 56 px, its name and its specialty.
    expect($(".editor-id .mascot-host svg").getAttribute("width")).toBe("56");
    expect($(".editor-name").textContent).toBe("Agenda");
    expect($(".editor-specialty").textContent).toBe("Agenda e e-mail");
    expect(tab("Mascot").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Mascot"));
    expect($(".editor-title").textContent).toBe("Mascot");
  });

  it("lists every section, each one ready", () => {
    open();
    const tabs = $$(".editor-tabs [role='tab']");
    expect(tabs.map((each) => each.querySelector(".nl").textContent)).toEqual([
      "Profile",
      "Mascot",
      "Soul",
      "Rules",
      "Memory",
      "Skills",
    ]);
    expect(tabs.every((each) => !each.hasAttribute("aria-disabled"))).toBe(true);
    tab("Soul").click();
    expect(tab("Soul").getAttribute("aria-selected")).toBe("true");
  });

  it("moves between its sections as APG tabs, and wraps", () => {
    open();
    key(tab("Mascot"), "ArrowDown");
    expect(tab("Soul").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Soul"));
    expect($("#editor-panel").getAttribute("aria-labelledby")).toBe("editor-tab-soul");
    key(tab("Soul"), "Home");
    expect(tab("Profile").getAttribute("aria-selected")).toBe("true");
    key(tab("Profile"), "ArrowUp");
    expect(tab("Skills").getAttribute("aria-selected")).toBe("true");
    key(tab("Skills"), "End");
    expect(tab("Skills").getAttribute("aria-selected")).toBe("true");
    key(tab("Skills"), "ArrowDown");
    expect(tab("Profile").getAttribute("aria-selected")).toBe("true");
  });

  it("closes with Escape, its focus back on the pencil", () => {
    open();
    key(tab("Mascot"), "Escape");
    expect($("#editor")).toBeNull();
    expect(document.activeElement).toBe(pen());
    expect(pen().getAttribute("aria-expanded")).toBe("false");
    expect(editor.agentId).toBeNull();
  });

  it("names every icon button for screen readers and in a tooltip, and nothing uses title", () => {
    open();
    for (const icon of $$("#editor .icb")) {
      expect(icon.getAttribute("aria-label"), icon.outerHTML.slice(0, 60)).toMatch(/\S/);
      expect(icon.hasAttribute("data-tip")).toBe(true);
      expect(icon.querySelector(".tip")).not.toBeNull();
    }
    expect($$("#editor [title]")).toEqual([]);
  });
});

describe("the Profile section", () => {
  it("edits the name, the specialty and the short description, each with its count", () => {
    open();
    tab("Profile").click();
    const name = $("#editor-name");
    const specialty = $("#editor-specialty");
    const remit = $("#editor-remit");
    expect([name.value, specialty.value, remit.value]).toEqual([
      "Agenda",
      "Agenda e e-mail",
      "Books meetings.",
    ]);
    expect([name.maxLength, specialty.maxLength, remit.maxLength]).toEqual([80, 40, 200]);
    expect(specialty.closest(".fld").querySelector(".count").textContent).toBe("15 of 40");
    remit.value = "Books meetings and answers mail.";
    remit.dispatchEvent(new Event("input"));
    expect(remit.closest(".fld").querySelector(".count").textContent).toBe("32 of 200");
    expect(tab("Profile").getAttribute("aria-label")).toBe("Profile, changed");
    expect(footer().querySelector(".dirty").textContent).toBe("1 unsaved change");
    // The agent on the left follows what the owner writes.
    specialty.value = "Agenda";
    specialty.dispatchEvent(new Event("input"));
    expect($(".editor-specialty").textContent).toBe("Agenda");
  });

  it("keeps the main agent's specialty locked, and says why", () => {
    open(MAIN);
    tab("Profile").click();
    const specialty = $("#editor-specialty");
    expect(specialty.readOnly).toBe(true);
    expect(specialty.value).toBe("main");
    expect($(`#${specialty.getAttribute("aria-describedby")}`).textContent).toBe(
      T.editor.specialtyLocked,
    );
    expect($(".editor-specialty").textContent).toBe("main");
  });

  it("won't save a name that shows nothing, and says what to write", async () => {
    open();
    tab("Profile").click();
    const name = $("#editor-name");
    name.value = "   ";
    name.dispatchEvent(new Event("input"));
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect($("#editor-name-error").hidden).toBe(false);
    expect($(".save").getAttribute("aria-disabled")).toBe("true");
    await editor.save();
    expect(sent).toEqual([]);
  });
});

describe("the Mascot section", () => {
  it("works every axis as an APG radiogroup: the arrows move, select and wrap", () => {
    open();
    const shapes = radios("Shape");
    expect(shapes).toHaveLength(12);
    expect(shapes.map(nameOf)).toContain("Pebble");
    expect(nameOf(checked("Shape"))).toBe("Pebble");
    // Tab enters on the checked option.
    expect(shapes.filter((radio) => radio.tabIndex === 0)).toEqual([checked("Shape")]);
    checked("Shape").focus();
    key(document.activeElement, "ArrowRight");
    expect(nameOf(checked("Shape"))).toBe("Buoy");
    expect(document.activeElement).toBe(checked("Shape"));
    radios("Shape").at(-1).click();
    key(radios("Shape").at(-1), "ArrowDown");
    expect(nameOf(checked("Shape"))).toBe("Mark");
    key(document.activeElement, "ArrowLeft");
    expect(nameOf(checked("Shape"))).toBe("Block");
    // Each tile draws its option on this agent's mascot, Still, at 46 px.
    expect(shapes[0].querySelector(".mascot-host svg").getAttribute("width")).toBe("46");
  });

  it("says the look in one line, which is the preview's text alternative", () => {
    open();
    const preview = $(".mascot-host.preview");
    expect(preview.getAttribute("role")).toBe("img");
    const summary = $(`#${preview.getAttribute("aria-labelledby")}`);
    expect(summary.textContent).toBe("Pebble · Fawn · Big eyes · round ears · no accessory");
    radios("Shape")[0].click();
    expect(summary.textContent).toBe("Mark · Fawn · Big eyes · round ears · no accessory");
  });

  it("names its colors, six to a row, and puts cheeks on a switch beside the eyes", () => {
    open();
    $$(".axis-tab")
      .find((each) => each.textContent === "Color")
      .click();
    expect(radios("Color").map(nameOf)).toEqual([
      "Kelp",
      "Lagoon",
      "Tide",
      "Sky",
      "Indigo",
      "Anemone",
      "Pink",
      "Fawn",
      "Cocoa",
      "Moss",
      "Lime",
      "Slate",
    ]);
    expect($(".tiles.swatches")).not.toBeNull();
    $$(".axis-tab")
      .find((each) => each.textContent === "Eyes")
      .click();
    const cheeks = $("[role='switch']");
    expect(cheeks.textContent).toBe("Rosy cheeks");
    cheeks.click();
    expect(cheeks.getAttribute("aria-checked")).toBe("true");
  });

  it("picks a part's type, then its variation in a second radiogroup", () => {
    open();
    const axisTab = (name) => $$(".axis-tab").find((each) => each.textContent === name);
    axisTab("Head").click();
    expect(radios("Head").map(nameOf)).toEqual(["Nothing", "Ears", "Horns", "Hair", "Leaves"]);
    expect(radios("Variation").map(nameOf)).toEqual(["Pointed", "Floppy", "Round"]);
    checked("Head").focus();
    key(document.activeElement, "ArrowRight");
    expect(nameOf(checked("Head"))).toBe("Horns");
    expect(document.activeElement).toBe(checked("Head"));
    expect(radios("Variation").map(nameOf)).toEqual(["Two", "One", "Antennae"]);
    radios("Head")[0].click();
    expect($(".tiles.variations").hidden).toBe(true);
    // The axis tabs are APG tabs too.
    axisTab("Head").focus();
    key(axisTab("Head"), "ArrowRight");
    expect(axisTab("Accessory").getAttribute("aria-selected")).toBe("true");
    key(axisTab("Accessory"), "Home");
    expect(axisTab("Shape").getAttribute("aria-selected")).toBe("true");
  });

  it("undoes every step since it opened, its tooltip naming the step, and ⌘Z too", () => {
    open();
    const undo = $(".pv-act .icb");
    expect(undo.getAttribute("aria-label")).toBe("Undo");
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.querySelector(".tip").textContent).toBe("Nothing to undo");
    radios("Shape")[0].click();
    $$(".axis-tab")
      .find((each) => each.textContent === "Color")
      .click();
    radios("Color")[6].click();
    expect(undo.getAttribute("aria-label")).toBe("Undo color");
    undo.click();
    expect(nameOf(checked("Color"))).toBe("Fawn");
    expect(undo.getAttribute("aria-label")).toBe("Undo shape");
    key(checked("Color"), "z", { metaKey: true });
    expect($(".pv-sum").textContent).toContain("Pebble");
    expect(tab("Mascot").getAttribute("aria-label")).toBe("Mascot");
    expect(undo.getAttribute("aria-disabled")).toBe("true");
  });

  it("marks what Undo brought back: a tint on a tile, a pop on a swatch, the switch for cheeks", () => {
    open();
    const animate = vi.spyOn(HTMLElement.prototype, "animate");
    const undo = $(".pv-act .icb");
    const axisTab = (name) => $$(".axis-tab").find((each) => each.textContent === name);
    radios("Shape")[0].click();
    undo.click();
    const tinted = animate.mock.calls.find(([frames]) => "backgroundColor" in frames[0]);
    expect(tinted[0][0].backgroundColor).toContain("22%");
    expect(animate.mock.contexts.at(animate.mock.calls.indexOf(tinted))).toBe(checked("Shape"));
    axisTab("Color").click();
    radios("Color")[0].click();
    animate.mockClear();
    undo.click();
    const popped = animate.mock.calls.findIndex(
      ([frames]) => frames[0].transform === "scale(1.25)",
    );
    expect(animate.mock.contexts[popped]).toBe(checked("Color"));
    axisTab("Eyes").click();
    $("[role='switch']").click();
    expect(undo.getAttribute("aria-label")).toBe("Undo cheeks");
    animate.mockClear();
    undo.click();
    expect($("[role='switch']").getAttribute("aria-checked")).toBe("false");
    expect(animate.mock.contexts).toContain($("[role='switch']"));
    animate.mockRestore();
  });

  it("randomizes a part's type and variation together, its variations following", () => {
    open();
    $$(".axis-tab")
      .find((each) => each.textContent === "Accessory")
      .click();
    expect(nameOf(checked("Accessory"))).toBe("None");
    radios("Accessory")
      .find((radio) => nameOf(radio) === "Bow")
      .click();
    expect(radios("Variation").map(nameOf)).toEqual(["Bow tie", "On the head"]);
    expect(nameOf(checked("Variation"))).toBe("Bow tie");
    radios("Variation")[1].click();
    expect($(".pv-sum").textContent).toContain("a bow on its head");
    $(".tabp-h .icb").click();
    expect($(".pv-sum").textContent).not.toContain("a bow on its head");
    expect($(".pv-act .icb").getAttribute("aria-label")).toBe("Undo accessory");
  });

  it("randomizes every axis, or one, without a Back to default", () => {
    open();
    const before = $(".pv-sum").textContent;
    const shuffle = $$(".pv-act .icb")[1];
    expect(shuffle.getAttribute("aria-label")).toBe("Randomize all");
    shuffle.click();
    expect($(".pv-sum").textContent).not.toBe(before);
    expect($(".pv-act .icb").getAttribute("aria-label")).toBe("Undo randomize");
    const axis = $(".tabp-h .icb");
    expect(axis.getAttribute("aria-label")).toBe("Randomize shape");
    const shape = nameOf(checked("Shape"));
    axis.click();
    expect(nameOf(checked("Shape"))).not.toBe(shape);
    expect($$("#editor button").map((each) => each.textContent)).not.toContain("Back to default");
  });

  it("pets the preview on a tap, as a tap on a mascot means (5.19)", () => {
    open();
    const preview = $(".mascot-host.preview");
    const pet = vi.spyOn(preview.mascot, "pet");
    preview.click();
    expect(pet).toHaveBeenCalledOnce();
  });
});

describe("saving", () => {
  it("writes each changed section once: the mascot whole and the profile's changed fields", async () => {
    open();
    radios("Shape")[0].click();
    radios("Shape")[1].click();
    tab("Profile").click();
    const name = $("#editor-name");
    name.value = " Agendas ";
    name.dispatchEvent(new Event("input"));
    expect(footer().querySelector(".dirty").textContent).toBe("2 unsaved changes");
    const save = $(".save");
    expect(saveLabel()).toBe("Save");
    point();
    save.click();
    expect(saveLabel()).toBe("Saving");
    await settle();
    const bubble = { ...AGENDA.mascot, shape: "bubble" };
    expect(sent).toEqual([
      { agentId: "agenda", section: "profile", body: { name: "Agendas" } },
      { agentId: "agenda", section: "mascot", body: bubble },
    ]);
    expect(saved).toEqual([["agenda", { name: "Agendas", mascot: bubble }]]);
    expect(saveLabel()).toBe("Saved");
    expect(save.dataset.state).toBe("done");
    expect(save.querySelector(".icon-check")).not.toBeNull();
    expect(footer().querySelector(".dirty").textContent).toBe("All saved");
    expect(tab("Profile").getAttribute("aria-label")).toBe("Profile");
  });

  it("closes once the mascot has celebrated, and offers Undo in a toast for 10 s", async () => {
    open();
    radios("Shape")[0].click();
    await editor.save();
    expect($("#editor")).not.toBeNull();
    vi.advanceTimersByTime(APPROVED_MS);
    expect($("#editor")).toBeNull();
    expect(document.activeElement).toBe(pen());
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      text: "Agenda: mascot saved",
      detail: T.editor.photoSoon,
      undo: true,
      action: { label: "Undo" },
    });
    expect(UNDO_TOAST_MS).toBe(10_000);
    // Undo sends the mascot from before.
    sent.length = 0;
    await shown[0].action.run();
    expect(sent).toEqual([{ agentId: "agenda", section: "mascot", body: AGENDA.mascot }]);
    expect(saved.at(-1)).toEqual(["agenda", { mascot: AGENDA.mascot }]);
    expect(shown.at(-1)).toEqual({ text: "Agenda: change undone" });
  });

  it("undoes only the profile's fields it changed, never the main agent's specialty", async () => {
    open(MAIN);
    tab("Profile").click();
    const remit = $("#editor-remit");
    remit.value = "Your day.";
    remit.dispatchEvent(new Event("input"));
    await editor.save();
    expect(sent).toEqual([{ agentId: "kelpie", section: "profile", body: { remit: "Your day." } }]);
    vi.advanceTimersByTime(APPROVED_MS);
    expect(shown[0]).toMatchObject({ text: "Kelpie: profile saved", detail: "" });
    sent.length = 0;
    await shown[0].action.run();
    expect(sent).toEqual([{ agentId: "kelpie", section: "profile", body: { remit: "" } }]);
  });

  it("stays open when the owner goes on editing before it closes", async () => {
    open();
    radios("Shape")[0].click();
    await editor.save();
    radios("Shape")[1].click();
    vi.advanceTimersByTime(APPROVED_MS);
    expect($("#editor")).not.toBeNull();
    expect(saveLabel()).toBe("Save");
    expect(footer().querySelector(".dirty").textContent).toBe("1 unsaved change");
  });

  it("saves with ⌘S from anywhere in it", async () => {
    open();
    radios("Shape")[0].click();
    key(radios("Shape")[0], "s", { metaKey: true });
    await settle();
    expect(sent.map((each) => each.section)).toEqual(["mascot"]);
  });

  it("names what didn't save when a save fails in part, and offers to save it again", async () => {
    open();
    radios("Shape")[0].click();
    tab("Profile").click();
    const remit = $("#editor-remit");
    remit.value = "Meetings.";
    remit.dispatchEvent(new Event("input"));
    answers.profile = { ok: false, status: 503 };
    await editor.save();
    const foot = footer();
    expect(foot.getAttribute("role")).toBe("alert");
    expect(foot.textContent).toContain("The Profile wasn't saved");
    expect(foot.textContent).toContain("The Mascot is saved.");
    expect(tab("Profile").getAttribute("aria-label")).toBe("Profile, not saved");
    expect(tab("Profile").querySelector(".mark-dot").dataset.state).toBe("failed");
    expect(tab("Mascot").getAttribute("aria-label")).toBe("Mascot");
    expect(saved).toEqual([["agenda", { mascot: { ...AGENDA.mascot, shape: "mark" } }]]);
    delete answers.profile;
    sent.length = 0;
    button("Save the Profile").click();
    await settle();
    expect(sent).toEqual([{ agentId: "agenda", section: "profile", body: { remit: "Meetings." } }]);
    expect(tab("Profile").getAttribute("aria-label")).toBe("Profile");
  });

  it("says which section failed when it was the only one, and the login expired when Access says so", async () => {
    open();
    radios("Shape")[0].click();
    answers.mascot = { ok: false, status: 401 };
    await editor.save();
    expect(footer().textContent).toContain("The Mascot wasn't saved");
    expect(footer().textContent).toContain(T.editor.tryAgain);
    expect(button("Save the Mascot")).toBeDefined();
    expect(expired).toHaveBeenCalledOnce();
    expect(saved).toEqual([]);
    // Editing again brings the footer back.
    radios("Shape")[2].click();
    expect($(".save")).not.toBeNull();
  });

  it("says nothing was saved when every section fails", async () => {
    open();
    radios("Shape")[0].click();
    tab("Profile").click();
    const name = $("#editor-name");
    name.value = "Agendas";
    name.dispatchEvent(new Event("input"));
    answers.mascot = { ok: false, status: 0 };
    answers.profile = { ok: false, status: 503 };
    await editor.save();
    expect(footer().textContent).toContain("Nothing was saved");
    expect(footer().textContent).not.toContain("is saved");
    expect(button("Save again")).toBeDefined();
    expect(expired).not.toHaveBeenCalled();
  });
});

describe("closing with changes", () => {
  it("asks inside the panel, never in a dialog over it", () => {
    open();
    radios("Shape")[0].click();
    button("Cancel").click();
    const foot = footer();
    expect(foot.getAttribute("role")).toBe("alertdialog");
    expect(foot.textContent).toContain("Discard 1 change?");
    expect(foot.textContent).toContain("Mascot goes back to what was saved.");
    expect(document.activeElement).toBe(button("Keep editing"));
    expect($$("dialog")).toEqual([]);
    // Escape keeps editing.
    key(document.activeElement, "Escape");
    expect($(".save")).not.toBeNull();
    expect($("#editor")).not.toBeNull();
  });

  it("discards, and nothing is saved", () => {
    open();
    radios("Shape")[0].click();
    key(tab("Mascot"), "Escape");
    button("Discard").click();
    expect($("#editor")).toBeNull();
    expect(sent).toEqual([]);
    expect(saved).toEqual([]);
    expect(document.activeElement).toBe(pen());
  });

  it("asks before opening another agent's editor over its changes", () => {
    open();
    radios("Shape")[0].click();
    expect(open(MAIN)).toBe(false);
    expect(editor.agentId).toBe("agenda");
    expect(footer().textContent).toContain("Discard 1 change?");
    button("Discard").click();
    expect(open(MAIN)).toBe(true);
    expect(editor.agentId).toBe("kelpie");
  });
});

describe("on the phone", () => {
  it("is a 90% sheet over the page, which Back and Escape close", () => {
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    open(AGENDA, { sheet: true, returnTo: document.getElementById("switcher") });
    expect($("#editor").classList.contains("sheet")).toBe(true);
    expect($("#editor").getAttribute("aria-modal")).toBe("true");
    expect($(".app").inert).toBe(true);
    expect($(".editor-scrim")).not.toBeNull();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect($("#editor")).toBeNull();
    expect($(".app").inert).toBe(false);
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it("asks before Back discards its changes", () => {
    const push = vi.spyOn(history, "pushState");
    vi.spyOn(history, "back").mockImplementation(() => {});
    open(AGENDA, { sheet: true });
    radios("Shape")[0].click();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect($("#editor")).not.toBeNull();
    expect(footer().textContent).toContain("Discard 1 change?");
    expect(push).toHaveBeenCalledTimes(2);
    button("Discard").click();
    expect(history.back).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("gives focus back to the switcher when its pencil is hidden by then", () => {
    vi.spyOn(history, "back").mockImplementation(() => {});
    document.getElementById("row").hidden = true;
    open(AGENDA, { sheet: true, returnTo: document.getElementById("switcher") });
    editor.close();
    expect(document.activeElement).toBe(document.getElementById("switcher"));
    vi.restoreAllMocks();
  });
});

describe("the review's cases (#379, round 1)", () => {
  /** A save's answer the test lets go of. */
  const held = () => {
    let release;
    const promise = new Promise((done) => {
      release = done;
    });
    return { promise, release };
  };

  it("keeps edits made while a save is on its way, and stays open for them", async () => {
    open();
    radios("Shape")[0].click();
    const answer = held();
    answers.mascot = answer.promise;
    const saving = editor.save();
    $$(".axis-tab")
      .find((each) => each.textContent === "Color")
      .click();
    radios("Color")[0].click();
    answer.release({ ok: true, value: { mascot: { ...AGENDA.mascot, shape: "mark" } } });
    await saving;
    vi.advanceTimersByTime(APPROVED_MS);
    expect($("#editor")).not.toBeNull();
    expect(shown).toEqual([]);
    expect(footer().querySelector(".dirty").textContent).toBe("1 unsaved change");
    expect(saveLabel()).toBe("Save");
    delete answers.mascot;
    sent.length = 0;
    await editor.save();
    expect(sent).toEqual([
      {
        agentId: "agenda",
        section: "mascot",
        body: { ...AGENDA.mascot, shape: "mark", color: "kelp" },
      },
    ]);
  });

  it("closes once a save it was asked to close during ends, with its toast", async () => {
    open();
    radios("Shape")[0].click();
    const answer = held();
    answers.mascot = answer.promise;
    const saving = editor.save();
    key(tab("Mascot"), "Escape");
    expect(footer().getAttribute("role")).toBeNull();
    expect($("#editor")).not.toBeNull();
    answer.release({ ok: true, value: { mascot: { ...AGENDA.mascot, shape: "mark" } } });
    await saving;
    expect($("#editor")).toBeNull();
    expect(shown.map((toast) => toast.text)).toEqual(["Agenda: mascot saved"]);
  });

  it("shows its toast when the owner closes it while it says Saved", async () => {
    open();
    radios("Shape")[0].click();
    await editor.save();
    key(tab("Mascot"), "Escape");
    expect($("#editor")).toBeNull();
    expect(shown.map((toast) => toast.text)).toEqual(["Agenda: mascot saved"]);
    vi.advanceTimersByTime(APPROVED_MS);
    expect(shown).toHaveLength(1);
  });

  it("follows a part's new type in its variations, after Undo and Randomize too", () => {
    open();
    $$(".axis-tab")
      .find((each) => each.textContent === "Head")
      .click();
    radios("Head")
      .find((radio) => nameOf(radio) === "Horns")
      .click();
    expect(radios("Variation").map(nameOf)).toEqual(["Two", "One", "Antennae"]);
    $(".pv-act .icb").click();
    expect(radios("Variation").map(nameOf)).toEqual(["Pointed", "Floppy", "Round"]);
    expect(nameOf(checked("Variation"))).toBe("Round");
    for (let draw = 0; draw < 12; draw++) {
      $(".tabp-h .icb").click();
      const type = nameOf(checked("Head"));
      const group = $(".tiles.variations");
      if (type === "Nothing") expect(group.hidden).toBe(true);
      else expect(radios("Variation").filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    }
  });

  it("keeps the preview on the page while another section shows, so it stays alive", () => {
    open();
    const preview = $(".mascot-host.preview");
    tab("Profile").click();
    expect(preview.isConnected).toBe(true);
    expect(preview.closest(".construtor").hidden).toBe(true);
    tab("Mascot").click();
    expect($(".mascot-host.preview")).toBe(preview);
  });

  it("knows the login expired when Access redirects the save", async () => {
    const fetch = vi.fn(async () => ({ type: "opaqueredirect", status: 0, ok: false }));
    vi.stubGlobal("fetch", fetch);
    editor = new Editor({
      texts: T,
      toasts: { show: () => {} },
      onSaved: () => {},
      onExpired: expired,
    });
    open();
    radios("Shape")[0].click();
    await editor.save();
    expect(fetch).toHaveBeenCalledWith(
      "/webchat/agents/agenda/mascot",
      expect.objectContaining({ method: "PUT", redirect: "manual" }),
    );
    expect(expired).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("drops what a pasted line can't hold, and an invisible name can't be saved", () => {
    open();
    tab("Profile").click();
    const name = $("#editor-name");
    name.value = `Agen${String.fromCodePoint(0x200b)}da\tOne`;
    name.dispatchEvent(new Event("input"));
    expect(name.value).toBe("Agenda One");
    name.value = String.fromCodePoint(0x3164);
    name.dispatchEvent(new Event("input"));
    expect($(".save").getAttribute("aria-disabled")).toBe("true");
    expect($("#editor-name-error").hidden).toBe(false);
  });

  it("clears a failed mark once its change is undone", async () => {
    open();
    tab("Profile").click();
    const remit = $("#editor-remit");
    remit.value = "Meetings.";
    remit.dispatchEvent(new Event("input"));
    answers.profile = { ok: false, status: 503 };
    await editor.save();
    expect(tab("Profile").getAttribute("aria-label")).toBe("Profile, not saved");
    remit.value = AGENDA.remit;
    remit.dispatchEvent(new Event("input"));
    expect(tab("Profile").getAttribute("aria-label")).toBe("Profile");
    expect(tab("Profile").querySelector(".mark-dot").dataset.state).toBeUndefined();
  });

  it("keeps what a profile save set before it failed", async () => {
    open();
    tab("Profile").click();
    for (const [id, value] of [
      ["editor-name", "Agendas"],
      ["editor-specialty", "Agenda"],
    ]) {
      const input = $(`#${id}`);
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }
    answers.profile = { ok: false, status: 503, value: { specialty: "Agenda" } };
    await editor.save();
    expect(saved).toEqual([["agenda", { specialty: "Agenda" }]]);
    expect(footer().textContent).toContain("The Profile wasn't saved");
    delete answers.profile;
    sent.length = 0;
    await editor.save();
    expect(sent).toEqual([{ agentId: "agenda", section: "profile", body: { name: "Agendas" } }]);
  });
});

describe("the review's cases (#379, round 2)", () => {
  it("hides the section that isn't shown, though the stylesheet lays each one out", () => {
    // Read from disk: the page's DOM loads no stylesheet, and an author `display` beats `[hidden]`.
    const css = readFileSync(
      join(fileURLToPath(import.meta.url), "../../../public/webchat/style.css"),
      "utf8",
    );
    for (const section of [".flds", ".construtor"]) {
      expect(css, section).toMatch(
        new RegExp(`\\${section}\\[hidden\\][^{]*\\{\\s*display: none;`),
      );
    }
  });

  it("gives a save 15 s before it counts as failed, so the panel never waits for good", async () => {
    const fetch = vi.fn(async () => Response.json({ mascot: AGENDA.mascot }));
    vi.stubGlobal("fetch", fetch);
    editor = new Editor({ texts: T, toasts: { show: () => {} }, onSaved: () => {} });
    open();
    radios("Shape")[0].click();
    await editor.save();
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it("undoes every field a retried profile save set, the first attempt's too", async () => {
    open();
    tab("Profile").click();
    for (const [id, value] of [
      ["editor-specialty", "Agenda"],
      ["editor-remit", "Meetings."],
    ]) {
      const input = $(`#${id}`);
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }
    answers.profile = { ok: false, status: 503, value: { specialty: "Agenda" } };
    await editor.save();
    delete answers.profile;
    await editor.save();
    vi.advanceTimersByTime(APPROVED_MS);
    sent.length = 0;
    await shown.at(-1).action.run();
    expect(sent).toEqual([
      {
        agentId: "agenda",
        section: "profile",
        body: { remit: AGENDA.remit, specialty: AGENDA.specialty },
      },
    ]);
  });

  it("closes after a save when the phone's Back comes during it", async () => {
    vi.spyOn(history, "back").mockImplementation(() => {});
    open(AGENDA, { sheet: true });
    radios("Shape")[0].click();
    let release;
    answers.mascot = new Promise((done) => {
      release = done;
    });
    const saving = editor.save();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(footer().getAttribute("role")).toBeNull();
    release({ ok: true, value: { mascot: { ...AGENDA.mascot, shape: "mark" } } });
    await saving;
    expect($("#editor")).toBeNull();
    // It takes back the place Back gave it while the save was on its way.
    expect(history.back).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});

describe("the review's cases (#379, round 3)", () => {
  it("keeps the sheet's place in history when Back comes during a save that fails", async () => {
    const push = vi.spyOn(history, "pushState");
    vi.spyOn(history, "back").mockImplementation(() => {});
    open(AGENDA, { sheet: true });
    radios("Shape")[0].click();
    let release;
    answers.mascot = new Promise((done) => {
      release = done;
    });
    const saving = editor.save();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(push).toHaveBeenCalledTimes(2);
    release({ ok: false, status: 503 });
    await saving;
    expect($("#editor")).not.toBeNull();
    expect(footer().textContent).toContain("The Mascot wasn't saved");
    // The next Back asks, as Back with changes always does, and never leaves the page.
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(footer().textContent).toContain("Discard 1 change?");
    expect(push).toHaveBeenCalledTimes(3);
  });

  it("counts a save that doesn't answer in 15 s as failed, and offers it again", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    editor = new Editor({ texts: T, toasts: { show: () => {} }, onSaved: () => {} });
    open();
    radios("Shape")[0].click();
    await editor.save();
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS);
    expect(SAVE_TIMEOUT_MS).toBe(15_000);
    expect(footer().textContent).toContain("The Mascot wasn't saved");
    expect(footer().textContent).toContain(T.editor.tryAgain);
    expect(button("Save the Mascot")).toBeDefined();
  });

  it("forgets a partial save's Undo once a save completes it", async () => {
    open();
    tab("Profile").click();
    const type = (id, value) => {
      const input = $(`#${id}`);
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    type("editor-specialty", "Agenda");
    type("editor-remit", "Meetings.");
    answers.profile = { ok: false, status: 503, value: { specialty: "Agenda" } };
    await editor.save();
    delete answers.profile;
    await editor.save();
    // Edited again before it closes, then saved: the toast's Undo is this save's alone.
    type("editor-name", "Agendas");
    await editor.save();
    vi.advanceTimersByTime(APPROVED_MS);
    sent.length = 0;
    await shown.at(-1).action.run();
    expect(sent).toEqual([{ agentId: "agenda", section: "profile", body: { name: "Agenda" } }]);
  });
});
