import { describe, expect, it } from "vitest";
import { paceBubbles, splitReply } from "../src/index.ts";

const chat = { maxLength: 200, maxBubbles: 4, conversational: true };

describe("splitReply, conversational mode", () => {
  it("turns each paragraph into a bubble", () => {
    expect(splitReply("Oi! Tudo certo.\n\nVi o seu pedido.\n\nJá está a caminho.", chat)).toEqual([
      "Oi! Tudo certo.",
      "Vi o seu pedido.",
      "Já está a caminho.",
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(splitReply("  \n\n ", chat)).toEqual([]);
  });

  it("keeps a code block whole, even with blank lines inside it", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitReply(`Veja:\n\n${code}\n\nPronto.`, chat)).toEqual(["Veja:", code, "Pronto."]);
  });

  it("keeps a list together as one bubble", () => {
    expect(splitReply("Itens:\n- arroz\n- feijão\n\nMais algo?", chat)).toEqual([
      "Itens:\n- arroz\n- feijão",
      "Mais algo?",
    ]);
  });

  it("merges the tail when there are more paragraphs than bubbles allowed", () => {
    const text = ["um", "dois", "três", "quatro", "cinco", "seis"].join("\n\n");
    expect(splitReply(text, chat)).toEqual(["um", "dois", "três", "quatro\n\ncinco\n\nseis"]);
  });

  it("splits a long paragraph at sentence boundaries", () => {
    const sentence = "Esta frase tem mais ou menos sessenta caracteres no total.";
    const paragraph = [sentence, sentence, sentence, sentence].join(" ");
    const bubbles = splitReply(paragraph, { ...chat, maxLength: 130 });
    expect(bubbles).toEqual([`${sentence} ${sentence}`, `${sentence} ${sentence}`]);
  });

  it("never exceeds the channel's maximum length", () => {
    const text = `${"palavra ".repeat(120)}\n\n${"x".repeat(450)}`;
    for (const bubble of splitReply(text, { ...chat, maxLength: 100 })) {
      expect(bubble.length).toBeLessThanOrEqual(100);
    }
  });

  it("does not cut an emoji in half when a word must be cut", () => {
    const word = "😀".repeat(60); // 120 UTF-16 code units
    const bubbles = splitReply(word, { ...chat, maxLength: 25 });
    expect(bubbles.join("")).toBe(word);
    for (const bubble of bubbles) {
      expect(bubble.length).toBeLessThanOrEqual(25);
      expect(bubble).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it("re-opens and closes fences when a code block must be split", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const bubbles = splitReply(`\`\`\`ts\n${lines}\n\`\`\``, { ...chat, maxLength: 80 });
    expect(bubbles.length).toBeGreaterThan(1);
    for (const bubble of bubbles) {
      expect(bubble.startsWith("```ts\n")).toBe(true);
      expect(bubble.endsWith("\n```")).toBe(true);
      expect(bubble.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("splitReply, fences and edge cases", () => {
  it("closes a fence only with the same character and at least as many marks", () => {
    const outer = "````md\n```js\nx\n```\n````";
    expect(splitReply(`a\n\n${outer}\n\nafter\n\nmore`, chat)).toEqual([
      "a",
      outer,
      "after",
      "more",
    ]);
  });

  it("treats triple backticks inside a sentence as text, not as a fence", () => {
    expect(splitReply("```x``` oi\n\nB\n\nC", chat)).toEqual(["```x``` oi", "B", "C"]);
  });

  it("recognizes tilde fences", () => {
    const code = "~~~\na\n\nb\n~~~";
    expect(splitReply(`${code}\n\nfim`, chat)).toEqual([code, "fim"]);
  });

  it("keeps the first line's indentation", () => {
    expect(splitReply("  - a\n  - b", chat)).toEqual(["  - a\n  - b"]);
  });

  it("treats a bubble cap below 1 as 1", () => {
    expect(splitReply("a\n\nb\n\nc", { ...chat, maxBubbles: 0 })).toEqual(["a\n\nb\n\nc"]);
  });

  it("drops the fence when the limit is too small to hold it, instead of exceeding the limit", () => {
    for (const bubble of splitReply("```typescript\nabcdef\n```", { ...chat, maxLength: 8 })) {
      expect(bubble.length).toBeLessThanOrEqual(8);
    }
  });
});

describe("splitReply, conversational mode off", () => {
  const single = { maxLength: 200, maxBubbles: 4, conversational: false };

  it("sends one message when it fits", () => {
    expect(splitReply("Um.\n\nDois.\n\nTrês.", single)).toEqual(["Um.\n\nDois.\n\nTrês."]);
  });

  it("packs paragraphs into as few messages as the maximum length allows", () => {
    const paragraph = "p".repeat(90);
    expect(splitReply([paragraph, paragraph, paragraph].join("\n\n"), single)).toEqual([
      `${paragraph}\n\n${paragraph}`,
      paragraph,
    ]);
  });
});

describe("paceBubbles", () => {
  const pacing = { minGapMs: 0 };

  it("waits longer for longer bubbles, between a floor and a ceiling", () => {
    expect(paceBubbles(["oi"], pacing)).toEqual([850]); // 800 + 25 × 2
    expect(paceBubbles(["a".repeat(40)], pacing)).toEqual([1_800]);
    expect(paceBubbles(["a".repeat(1_000)], pacing)).toEqual([4_000]);
  });

  it("never sends faster than the channel allows", () => {
    // WhatsApp allows one message every 6 s to the same user.
    expect(paceBubbles(["oi", "tudo bem?"], { minGapMs: 6_000 })).toEqual([6_000, 6_000]);
  });
});
