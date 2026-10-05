import { describe, expect, it } from "vitest";
import { maskPersonalData } from "../src/index.ts";

describe("maskPersonalData", () => {
  it.each([
    ["meu email é ana.souza+loja@exemplo.com.br", "meu email é [email]"],
    ["me liga no (11) 98765-4321", "me liga no [number]"],
    ["whats +55 11 98765 4321", "whats [number]"],
    ["cpf 123.456.789-09", "cpf [number]"],
    ["meu cpf é 12345678909", "meu cpf é [number]"],
    ["cnpj 12.345.678/0001-90", "cnpj [number]"],
    ["cartão 4111 1111 1111 1111", "cartão [number]"],
  ])("masks %s", (input, expected) => {
    expect(maskPersonalData(input)).toBe(expected);
  });

  it.each(["o pedido 4821 chegou", "às 14h", "comprei 3 itens por R$ 59,90", "dia 05/10"])(
    "keeps short numbers in %s",
    (text) => {
      expect(maskPersonalData(text)).toBe(text);
    },
  );

  it("masks every string inside arrays and objects, and leaves other values alone", () => {
    expect(
      maskPersonalData({
        fragments: ["oi", "meu cpf é 12345678909"],
        count: 2,
        ok: true,
        none: null,
      }),
    ).toEqual({ fragments: ["oi", "meu cpf é [number]"], count: 2, ok: true, none: null });
  });
});
