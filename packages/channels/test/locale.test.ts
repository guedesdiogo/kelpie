import { describe, expect, it } from "vitest";
import { detectLocale, LOCALES, localeOf } from "../src/locale.ts";

// Kelpie's fixed texts come in English, Brazilian Portuguese or Spanish (#187): the language a
// person writes in, else the one their device selects, else English.

describe("localeOf", () => {
  it("reads a language tag or a header's first choice, in any case", () => {
    expect(localeOf("pt-BR")).toBe("pt-BR");
    expect(localeOf("pt")).toBe("pt-BR");
    expect(localeOf("pt_PT")).toBe("pt-BR");
    expect(localeOf("ES-419")).toBe("es");
    expect(localeOf("en-GB")).toBe("en");
    expect(localeOf("pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7")).toBe("pt-BR");
    expect(localeOf("en;q=0.5, es")).toBe("es");
  });

  it("gives nothing for a language Kelpie doesn't have, so the caller's fallback applies", () => {
    // The selected language is the first; a later choice doesn't stand in for it (#187).
    for (const value of ["fr-FR", "fr,pt;q=0.8", "", "*", "x;q=abc", null, undefined]) {
      expect(localeOf(value), String(value)).toBeNull();
    }
  });

  it("has English, Brazilian Portuguese and Spanish", () => {
    expect(LOCALES).toEqual(["en", "pt-BR", "es"]);
  });
});

describe("detectLocale", () => {
  it("reads the owner's own lines from the first setup run", () => {
    for (const line of [
      "Olá",
      "quais bots eu tenho ai?",
      "vamos criar um bot novo, o que sugere?",
      "feito",
      "mude para smart",
      "não, não faça isso",
    ]) {
      expect(detectLocale(line), line).toBe("pt-BR");
    }
  });

  it("reads Spanish and English", () => {
    for (const line of [
      "¿qué bots tengo?",
      "vamos a crear un bot nuevo",
      "hola",
      "listo, gracias",
    ]) {
      expect(detectLocale(line), line).toBe("es");
    }
    for (const line of ["what bots do I have?", "let's create a new bot", "done", "thanks"]) {
      expect(detectLocale(line), line).toBe("en");
    }
  });

  it("gives nothing when the text doesn't say", () => {
    for (const line of ["ok", "K7MPRX", "👍", "https://example.com/x", "sales-bot", ""]) {
      expect(detectLocale(line), line).toBeNull();
    }
  });
});
