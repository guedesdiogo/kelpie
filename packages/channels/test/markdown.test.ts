import { describe, expect, it } from "vitest";
import {
  type Block,
  fitsTelegram,
  formatReply,
  type Inline,
  linksOf,
  toTelegramHtml,
  toTelegramPlain,
  trimUrl,
} from "../src/markdown.ts";

// Replies in a small Markdown subset (#188): what the webchat and Telegram show. A link is a link
// only when the caller allows its URL; anything else is text, and on Telegram any address is code.

const none = new Set<string>();
const text = (value: string) => ({ type: "text", text: value });

/** What Telegram shows of its HTML: the text, without tags, unescaped. */
function shown(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

const telegram = (reply: string, allowed: ReadonlySet<string> = none) =>
  toTelegramHtml(formatReply(reply, allowed));

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
        tight: true,
      },
      {
        type: "list",
        ordered: true,
        start: 1,
        items: [[text("um")], [text("dois")]],
        numbers: [1, 2],
      },
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
    for (const reply of ["um *dois e snake_case_name e 2*3", "src/**/*.ts", "**a*", "a ** b"]) {
      expect(shown(telegram(reply)), reply).toBe(reply);
    }
    expect(shown(telegram("```js\nnever closed"))).toBe("never closed");
    expect(shown(telegram("*a **b** c*"))).toBe("a b c");
    expect(telegram("*a **b** c*")).toBe("<i>a <b>b</b> c</i>");
  });

  it("reads a run of three markers as bold and italics together", () => {
    expect(telegram("***x*** e ___y___")).toBe("<b><i>x</i></b> e <b><i>y</i></b>");
    expect(telegram("***Importante***: leia")).toBe("<b><i>Importante</i></b>: leia");
    expect(telegram("*x **y***")).toBe("<i>x <b>y</b></i>");
    expect(shown(telegram("**negrito***"))).toBe("negrito*");
  });

  it("reads a backtick fence whose info string holds a backtick as a paragraph", () => {
    const html = telegram("```npm test``` first\nrest");
    expect(html).not.toContain("<pre>");
    expect(shown(html)).toContain("npm test`` first\nrest");
  });

  it("still checks addresses however deep the markers go", () => {
    const url = "https://evil.example/?q=x";
    const deep = [
      `${"**".repeat(12)}see ${url}${"**".repeat(12)}`,
      `${"**a __a *a _a ".repeat(4)}see ${url}${" a_ a* a__ a**".repeat(4)}`,
      `[${"*".repeat(12)}${url}${"*".repeat(12)}](https://ok.example)`,
    ];
    for (const reply of deep) {
      const plain = JSON.stringify(formatReply(reply, none)).match(/"type":"text","text":"[^"]*/g);
      expect(plain?.join(" "), reply).not.toContain("https://");
    }
  });
});

describe("linksOf", () => {
  it("lists the addresses as the formatter reads them, so an allowed one always links", () => {
    const url = "https://a.example/x";
    for (const reply of [`**${url}**`, `*${url}*`, `[${url}](${url})`, `[see ${url}](${url})`]) {
      expect(linksOf(reply), reply).toEqual([url]);
      expect(telegram(reply, new Set(linksOf(reply))), reply).toContain(`<a href="${url}">`);
    }
    expect(linksOf(`\`${url}\` e [${url}](https://b.example) e mailto:x@y.example`)).toEqual([
      "https://b.example",
    ]);
  });

  it("trims what the sentence adds to a URL", () => {
    expect(trimUrl("https://x.example/wiki/Foo_(bar)).")).toBe("https://x.example/wiki/Foo_(bar)");
    expect(trimUrl('https://x.example/a?b=c."')).toBe("https://x.example/a?b=c");
  });
});

describe("formatReply on a hostile reply", () => {
  it("reads a long reply of unclosed markers in linear time", () => {
    // A channel's longest bubble, made only of openers that never close.
    for (const unit of ["*a ", "**a ", "_a ", "[a](", "`a", "**a *b ", "https://x.example/a "]) {
      const reply = unit.repeat(Math.ceil(16_000 / unit.length)).slice(0, 16_000);
      const started = performance.now();
      const html = telegram(reply);
      expect(performance.now() - started, unit).toBeLessThan(1_000);
      expect(shown(html).length, unit).toBeLessThanOrEqual(reply.length);
    }
  });

  it("reads lines and addresses built to backtrack in linear time", () => {
    // Four times the longest bubble: a quadratic step takes seconds at this size.
    const n = 64_000;
    const replies = {
      heading: `# ${" ".repeat(n)} x`,
      "heading with spaces": `# a${" ".repeat(n)}x`,
      bullet: `- ${" ".repeat(n)} x`,
      numbered: `1. ${" ".repeat(n)} x`,
      parentheses: `https://x.example/${")".repeat(n)}`,
      dots: `https://x.example/${".".repeat(n)}a`,
      "address dots": `evil.example/${".".repeat(n)}a`,
      labels: "a.".repeat(n / 2),
      word: `${"a".repeat(n)}.`,
      hyphens: "a-".repeat(n / 2),
      fence: `${"`".repeat(n)}\nx`,
      stars: `${"*".repeat(n / 2)}a${"*".repeat(n / 2)}`,
      "scheme-like": "/ab+c.d-e".repeat(n / 10),
    };
    for (const [name, reply] of Object.entries(replies)) {
      const started = performance.now();
      telegram(reply);
      linksOf(reply);
      toTelegramPlain(reply);
      trimUrl(reply);
      expect(performance.now() - started, name).toBeLessThan(1_000);
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
      '<b>a &lt; b</b> &amp; <i>c</i>\n• <code>x&lt;y&gt;</code>\n\n<a href="https://ok.example/?a=1&amp;b=&quot;2&quot;">go</a>\n\n<pre>&lt;pre&gt;</pre>',
    );
  });

  it("shows an ordered list's numbers as written", () => {
    expect(telegram("3. três\n4. quatro")).toBe("3. três\n4. quatro");
    expect(telegram("1. um\n1. dois")).toBe("1. um\n1. dois");
  });

  it("never nests code, which Telegram can't, in bold, italics or a link", () => {
    expect(telegram("**run `npm test` now**")).toBe("<b>run </b><code>npm test</code><b> now</b>");
    expect(telegram("**see https://evil.example/x**")).toBe(
      "<b>see </b><code>https://evil.example/x</code>",
    );
    expect(telegram("[`npm` docs](https://ok.example/d)", new Set(["https://ok.example/d"]))).toBe(
      '<a href="https://ok.example/d">npm docs</a>',
    );
  });

  it("puts in code any address Telegram would link on its own, whatever formatting it crosses", () => {
    expect(
      telegram(
        "Veja evil.example/login, www.evil.example e 192.168.0.1/admin. Ou evil.**example**.com.",
      ),
    ).toBe(
      "Veja <code>evil.example/login</code>, <code>www.evil.example</code> e <code>192.168.0.1/admin</code>. Ou <code>evil.example.com</code>.",
    );
    expect(telegram("Custa 3.5 vezes, e.g. a v1.2.")).toBe("Custa 3.5 vezes, e.g. a v1.2.");
    expect(telegram("Abra tg://resolve?domain=evil_bot ou xhttps://evil.example.")).toBe(
      "Abra <code>tg://resolve?domain=evil_bot</code> ou x<code>https://evil.example</code>.",
    );
  });

  it("keeps within the entities Telegram reads, so no code span is dropped", () => {
    const busy = `${"**a** ".repeat(95)}veja evil.example/login`;
    expect(fitsTelegram(telegram(busy))).toBe(false);
    expect(fitsTelegram(toTelegramPlain(busy))).toBe(true);
    const addresses = "evil.example/x ".repeat(95);
    expect(toTelegramPlain(addresses)).toBe(`<pre>${addresses}</pre>`);
  });

  it("sends a reply as written, its addresses in code, when the formatted one can't go", () => {
    expect(toTelegramPlain("Please verify: https://evil.example/login\n- a & <b>")).toBe(
      "Please verify: <code>https://evil.example/login</code>\n- a &amp; &lt;b&gt;",
    );
  });
});

describe("formatted replies, whatever the model writes", () => {
  // A seeded generator: the same replies on every run.
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }
  const pieces = [
    "*",
    "**",
    "_",
    "__",
    "`",
    "[",
    "](",
    ")",
    "(",
    "\n",
    "\n\n",
    "- ",
    "1. ",
    "10. ",
    "# ",
    "```\n",
    " ",
    ".",
    "\\",
    " ",
    "a",
    "word",
    "evil",
    "example",
    "<b>",
    "&",
    "https://ok.example/a",
    "https://evil.example/x",
    "www.evil.example",
    "evil.example/login",
  ];
  const allowed = new Set(["https://ok.example/a"]);

  function links(nodes: readonly Inline[]): string[] {
    return nodes.flatMap((node) =>
      node.type === "link"
        ? [node.href, ...links(node.children)]
        : "children" in node
          ? links(node.children)
          : [],
    );
  }

  it("links only what it may, never shows more than was written, and nests what Telegram reads", () => {
    const next = random(188);
    for (let round = 0; round < 3_000; round += 1) {
      const count = 1 + Math.floor(next() * 40);
      let reply = "";
      for (let i = 0; i < count; i += 1) reply += pieces[Math.floor(next() * pieces.length)];

      const blocks = formatReply(reply, allowed);
      for (const block of blocks) {
        const inline =
          block.type === "paragraph"
            ? block.children
            : block.type === "list"
              ? block.items.flat()
              : [];
        for (const href of links(inline)) expect(allowed.has(href), reply).toBe(true);
      }

      const html = toTelegramHtml(blocks);
      expect(shown(html).length, reply).toBeLessThanOrEqual(reply.length);
      const open: string[] = [];
      for (const [, closing, tag] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
        if (closing) expect(open.pop(), reply).toBe(tag);
        else {
          if (tag === "code") expect(open, reply).toEqual([]);
          open.push(tag ?? "");
        }
      }
      expect(open, reply).toEqual([]);
      for (const [, href] of html.matchAll(/<a href="([^"]*)">/g)) {
        expect(href, reply).toBe("https://ok.example/a");
      }
      // Telegram links nothing in code, in a block of code, or in a link.
      const outside = shown(
        html.replace(/<(code|pre)>[^<]*<\/\1>/g, " ").replace(/<a [^>]*>[\s\S]*?<\/a>/g, " "),
      );
      // A host Telegram links ends where its top-level domain does (not `evil.example10`).
      expect(outside, reply).not.toMatch(/https?:\/\/|evil\.example(?![\p{L}\p{N}-])/u);
    }
  });
});
