import { describe, expect, it } from "vitest";
import { type Block, formatReply, toTelegramHtml, visibleText } from "../src/markdown.ts";

// Replies in a small Markdown subset (#188): what the webchat and Telegram show. A link is a link
// only when the caller allows its URL; anything else is text.

const none = new Set<string>();
const text = (value: string) => ({ type: "text", text: value });

describe("formatReply", () => {
  it("reads paragraphs, bold, italics and inline code", () => {
    expect(formatReply("Oi **Ana**, tudo *bem*?\nVeja `npm test`.\n\nAté _logo_.", none)).toEqual([
      {
        type: "paragraph",
        children: [
          text("Oi "),
          { type: "bold", children: [text("Ana")] },
          text(", tudo "),
          { type: "italic", children: [text("bem")] },
          text("?\nVeja "),
          { type: "code", text: "npm test" },
          text("."),
        ],
      },
      {
        type: "paragraph",
        children: [text("Até "), { type: "italic", children: [text("logo")] }, text(".")],
      },
    ]);
  });

  it("reads lists, headings as bold, and fenced code as it is", () => {
    const blocks = formatReply(
      "## Passos\n- crie o bot\n- cole o **token**\n\n1. um\n2. dois\n\n```sh\n**not bold** [x](https://a.example)\n```",
      none,
    );
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "bold", children: [text("Passos")] }] },
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [text("crie o bot")],
          [text("cole o "), { type: "bold", children: [text("token")] }],
        ],
      },
      { type: "list", ordered: true, start: 1, items: [[text("um")], [text("dois")]] },
      { type: "code", text: "**not bold** [x](https://a.example)" },
    ]);
  });

  it("links only the URLs it is allowed, and shows any other with its address in code", () => {
    const allowed = new Set(["https://admin.example/forms/abc"]);
    const blocks = formatReply(
      "Abra [o formulário](https://admin.example/forms/abc) ou [aqui](https://evil.example/x). Veja https://admin.example/forms/abc e https://other.example.",
      allowed,
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [
          text("Abra "),
          {
            type: "link",
            href: "https://admin.example/forms/abc",
            children: [text("o formulário")],
          },
          text(" ou "),
          text("aqui"),
          text(" ("),
          { type: "code", text: "https://evil.example/x" },
          text(")"),
          text(". Veja "),
          {
            type: "link",
            href: "https://admin.example/forms/abc",
            children: [text("https://admin.example/forms/abc")],
          },
          text(" e "),
          { type: "code", text: "https://other.example" },
          text("."),
        ],
      },
    ]);
  });

  it("never links another scheme, even when it is allowed, and never inside code", () => {
    const hostile = [
      "javascript:alert(1)",
      "data:text/html,hi",
      "//evil.example",
      "ftp://x.example/a",
    ];
    for (const href of hostile) {
      const blocks = formatReply(`[clique](${href})`, new Set(hostile));
      expect(JSON.stringify(blocks), href).not.toContain('"type":"link"');
    }
    const coded = formatReply(
      "`https://admin.example/a`\n\n```\nhttps://admin.example/a\n```",
      new Set(["https://admin.example/a"]),
    );
    expect(JSON.stringify(coded)).not.toContain('"type":"link"');
  });

  it("keeps raw HTML and unbalanced markers as text", () => {
    expect(formatReply("<script>alert(1)</script> **meio <b>x</b>", none)).toEqual([
      { type: "paragraph", children: [text("<script>alert(1)</script> **meio <b>x</b>")] },
    ]);
    expect(visibleText(formatReply("um *dois e snake_case_name e 2*3", none))).toBe(
      "um *dois e snake_case_name e 2*3",
    );
    expect(visibleText(formatReply("```js\nnever closed", none))).toBe("never closed");
  });

  it("never shows more than the raw text holds, so a split for the channel stays within its limit", () => {
    const samples = [
      "# Título\n- a\n- [b](https://x.example/very/long/path)\n\n1. c\n\n```ts\nconst x = 1;\n```",
      "**bold _nested_ text** and `code` and https://x.example/a?b=c&d=e.",
      "\\*not italic\\* and [label](https://blocked.example)",
    ];
    for (const sample of samples) {
      const shown = visibleText(formatReply(sample, none));
      expect(shown.length, sample).toBeLessThanOrEqual(sample.length);
    }
  });
});

describe("formatReply on a hostile reply", () => {
  it("reads a long reply of unclosed markers in linear time", () => {
    // A channel's longest bubble, made only of openers that never close.
    for (const unit of ["*a ", "**a ", "_a ", "[a](", "`a", "**a *b ", "https://x.example/a "]) {
      const reply = unit.repeat(Math.ceil(16_000 / unit.length)).slice(0, 16_000);
      const started = performance.now();
      const shown = visibleText(formatReply(reply, none));
      expect(performance.now() - started, unit).toBeLessThan(1_000);
      expect(shown.length, unit).toBeLessThanOrEqual(reply.length);
    }
  });
});

describe("toTelegramHtml", () => {
  it("writes Telegram's HTML, escaping every text and address", () => {
    const blocks: Block[] = formatReply(
      '**a < b** & *c*\n- `x<y>`\n\n[go](https://ok.example/?a=1&b="2")\n\n```\n<pre>\n```',
      new Set(['https://ok.example/?a=1&b="2"']),
    );
    expect(toTelegramHtml(blocks)).toBe(
      '<b>a &lt; b</b> &amp; <i>c</i>\n\n• <code>x&lt;y&gt;</code>\n\n<a href="https://ok.example/?a=1&amp;b=&quot;2&quot;">go</a>\n\n<pre>&lt;pre&gt;</pre>',
    );
  });

  it("numbers an ordered list from its start", () => {
    expect(toTelegramHtml(formatReply("3. três\n4. quatro", none))).toBe("3. três\n4. quatro");
  });
});
