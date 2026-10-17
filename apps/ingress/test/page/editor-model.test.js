import { describe, expect, it } from "vitest";
import {
  AXES,
  CHOICES,
  changedAxis,
  changedSections,
  PARTS,
  partOptions,
  profileChanges,
  profileOf,
  profileValid,
  randomizeAxis,
  randomLook,
  SECTIONS,
  summaryOf,
  withType,
} from "../../public/webchat/editor-model.js";
import { isDrawable } from "../../public/webchat/mascot-art.js";
import { TEXTS } from "../../public/webchat/texts.js";

// The agent editor's decisions (#379): its sections, the mascot's axes, a random look, the summary
// that is the preview's text alternative, and what changed since it opened.

const KELPIE = {
  shape: "mark",
  color: "kelp",
  eyes: "big",
  cheeks: false,
  head: { type: "ears", variation: "round" },
  accessory: { type: "none" },
};

describe("the editor's sections", () => {
  it("lists Profile and Mascot ready, and the agent's own files for #381", () => {
    expect(SECTIONS.map((section) => [section.id, section.ready])).toEqual([
      ["profile", true],
      ["mascot", true],
      ["soul", false],
      ["rules", false],
      ["memory", false],
      ["skills", false],
    ]);
  });
});

describe("the mascot's axes", () => {
  it("are ADR-0045's five, with every option the engine draws", () => {
    expect(AXES).toEqual(["shape", "color", "eyes", "head", "accessory"]);
    expect(CHOICES.shape).toHaveLength(12);
    expect(CHOICES.color).toHaveLength(12);
    expect(CHOICES.eyes).toHaveLength(10);
    expect(partOptions(PARTS.head)).toHaveLength(13);
    expect(partOptions(PARTS.accessory)).toHaveLength(10);
  });

  it("draws a random look from every option, and each one the engine can draw", () => {
    const looks = Array.from({ length: 300 }, () => randomLook());
    for (const look of looks) expect(isDrawable(look), JSON.stringify(look)).toBe(true);
    expect(new Set(looks.map((look) => look.shape)).size).toBe(12);
    expect(new Set(looks.map((look) => JSON.stringify(look.head))).size).toBe(13);
    expect(randomLook(() => 0)).toEqual({
      shape: "mark",
      color: "kelp",
      eyes: "dots",
      cheeks: true,
      head: { type: "none" },
      accessory: { type: "none" },
    });
  });

  it("draws one axis again, never to the option it has", () => {
    for (const axis of AXES) {
      for (let i = 0; i < 40; i++) {
        const drawn = randomizeAxis(KELPIE, axis);
        expect(drawn[axis]).not.toEqual(KELPIE[axis]);
        expect(isDrawable(drawn)).toBe(true);
        for (const other of AXES.filter((each) => each !== axis)) {
          expect(drawn[other]).toEqual(KELPIE[other]);
        }
      }
    }
  });

  it("keeps a part's variation while its type stays, and takes a new type's first", () => {
    const ears = { type: "ears", variation: "floppy" };
    expect(withType(ears, "ears", PARTS.head)).toBe(ears);
    expect(withType(ears, "horns", PARTS.head)).toEqual({ type: "horns", variation: "two" });
    expect(withType(ears, "none", PARTS.head)).toEqual({ type: "none" });
  });

  it("names the axis a step changed, or a draw of several", () => {
    expect(changedAxis(KELPIE, { ...KELPIE, color: "pink" })).toBe("color");
    expect(changedAxis(KELPIE, { ...KELPIE, cheeks: true })).toBe("cheeks");
    expect(changedAxis(KELPIE, { ...KELPIE, color: "pink", shape: "star" })).toBe("random");
  });
});

describe("the summary line", () => {
  it("says what the preview shows, in each language", () => {
    const look = {
      shape: "mark",
      color: "indigo",
      eyes: "shine",
      cheeks: false,
      head: { type: "ears", variation: "pointed" },
      accessory: { type: "belt", variation: "collar" },
    };
    expect(summaryOf(look, TEXTS["pt-BR"].editor)).toBe(
      "Marca · Índigo · olhos Brilho · orelhas pontudas · coleira",
    );
    expect(summaryOf({ ...look, cheeks: true }, TEXTS.en.editor)).toBe(
      "Mark · Indigo · Shine eyes with cheeks · pointed ears · a collar",
    );
    expect(summaryOf({ ...KELPIE, head: { type: "none" } }, TEXTS.es.editor)).toBe(
      "Marca · Kelp · ojos Grandes · nada en la cabeza · sin accesorio",
    );
  });

  it("names every option, in every language", () => {
    for (const locale of ["en", "pt-BR", "es"]) {
      const names = TEXTS[locale].editor;
      for (const shape of CHOICES.shape) expect(names.shapes[shape], shape).toMatch(/\S/);
      for (const color of CHOICES.color) expect(names.colors[color], color).toMatch(/\S/);
      for (const eyes of CHOICES.eyes) expect(names.eyes[eyes], eyes).toMatch(/\S/);
      for (const [axis, types] of Object.entries(PARTS)) {
        const typeNames = axis === "head" ? names.heads : names.accessories;
        for (const part of partOptions(types)) {
          expect(typeNames[part.type], `${locale} ${part.type}`).toMatch(/\S/);
          if (part.variation) {
            expect(names.variations[part.type][part.variation]).toMatch(/\S/);
            expect(names.phrases[part.type][part.variation]).toMatch(/\S/);
          }
        }
      }
    }
  });
});

describe("the editor's texts", () => {
  /** Every leaf of a text tree: a string, or a function that writes one. */
  function leaves(tree, path = []) {
    return Object.entries(tree).flatMap(([key, value]) =>
      typeof value === "object" ? leaves(value, [...path, key]) : [[[...path, key].join("."), value]],
    );
  }

  it("has every text in all three languages, each one written", () => {
    const shape = (texts) => leaves(texts.editor).map(([path]) => path).sort();
    expect(shape(TEXTS["pt-BR"])).toEqual(shape(TEXTS.en));
    expect(shape(TEXTS.es)).toEqual(shape(TEXTS.en));
    for (const locale of ["en", "pt-BR", "es"]) {
      for (const [path, value] of leaves(TEXTS[locale].editor)) {
        if (typeof value !== "function") {
          expect(value, `${locale} ${path}`).toMatch(/\S/);
          continue;
        }
        const written =
          path === "summary"
            ? value({ shape: "a", color: "b", eyes: "c", cheeks: true, head: "d", accessory: "e" })
            : path === "saved"
              ? value("Agenda", { profile: true, mascot: true })
              : path === "discardWhat"
                ? value(["Perfil", "Mascote"])
                : path === "options"
                  ? value("shape", 12)
                  : value(2, 3);
        expect(written, `${locale} ${path}`).toMatch(/\S/);
        expect(written, `${locale} ${path}`).not.toContain("undefined");
      }
    }
  });

  it("says one and several apart, and the button keeps its stem (Family Values)", () => {
    const pt = TEXTS["pt-BR"].editor;
    expect(pt.unsaved(1)).toBe("1 alteração não salva");
    expect(pt.unsaved(3)).toBe("3 alterações não salvas");
    expect(pt.discardAsk(3)).toBe("Descartar 3 alterações?");
    expect(pt.discardWhat(["Mascote"])).toBe("Mascote volta ao que estava salvo.");
    expect(pt.discardWhat(["Perfil", "Mascote"])).toBe("Perfil e Mascote voltam ao que estava salvo.");
    expect(`${pt.save.stem}${pt.save.idle}`).toBe("Salvar");
    expect(`${pt.save.stem}${pt.save.busy}`).toBe("Salvando");
    expect(`${pt.save.stem}${pt.save.done}`).toBe("Salvo");
    const en = TEXTS.en.editor;
    expect([en.save.idle, en.save.busy, en.save.done].map((end) => en.save.stem + end)).toEqual([
      "Save",
      "Saving",
      "Saved",
    ]);
    expect(en.saved("Agenda", { profile: false, mascot: true })).toBe("Agenda: mascot saved");
    expect(en.saved("Agenda", { profile: true, mascot: false })).toBe("Agenda: profile saved");
  });
});

describe("what changed", () => {
  const saved = {
    profile: { name: "Agenda", specialty: "Agenda e e-mail", remit: "Meetings." },
    mascot: KELPIE,
  };

  it("reads an agent's profile as the list sent it, with nothing for what it didn't", () => {
    expect(profileOf({ name: "Agenda", specialty: "Agenda e e-mail", remit: "Meetings." })).toEqual(
      saved.profile,
    );
    expect(profileOf({ name: "Kelpie" })).toEqual({ name: "Kelpie", specialty: "", remit: "" });
  });

  it("names the profile's fields that changed, trimmed, and never the main agent's specialty", () => {
    const draft = { name: " Agenda ", specialty: "Agenda", remit: "Meetings and mail." };
    expect(profileChanges(saved.profile, draft, { main: false })).toEqual({
      specialty: "Agenda",
      remit: "Meetings and mail.",
    });
    expect(profileChanges(saved.profile, draft, { main: true })).toEqual({
      remit: "Meetings and mail.",
    });
  });

  it("counts the sections that changed, each once", () => {
    const draft = { profile: { ...saved.profile }, mascot: KELPIE };
    expect(changedSections({ saved, draft, main: false })).toEqual([]);
    draft.mascot = { ...KELPIE, color: "pink" };
    expect(changedSections({ saved, draft, main: false })).toEqual(["mascot"]);
    draft.profile = { ...saved.profile, name: "Agendas", remit: "x" };
    expect(changedSections({ saved, draft, main: false })).toEqual(["profile", "mascot"]);
  });

  it("takes a profile only with a name that shows", () => {
    expect(profileValid({ name: "Agenda" })).toBe(true);
    expect(profileValid({ name: "   " })).toBe(false);
  });
});
