import { describe, expect, it } from "vitest";
import { renderBlocks } from "../../public/webchat/blocks.js";
import { lineMark, readInline, readMarkdown } from "../../public/webchat/markdown.js";
import { TEXTS } from "../../public/webchat/texts.js";

// An agent's own files, read in the page (#381): blocks.js's blocks with their source lines.

const text = (value) => ({ type: "text", text: value });

describe("an agent's Markdown", () => {
  it("reads headings, paragraphs, lists, quotes, rules and code, each with its lines", () => {
    const blocks = readMarkdown(
      [
        "# Kelpie",
        "",
        "Você é o Kelpie,",
        "o Master.",
        "",
        "## Como trabalha",
        "- Pergunta só quando muda.",
        "  e acompanha.",
        "- Pede confirmação.",
        "",
        "3. três",
        "4. quatro",
        "> Uma citação",
        "> em duas linhas",
        "***",
        "```js",
        "const x = '<b>';",
        "```",
        "Fim ##",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { type: "heading", level: 1, children: [text("Kelpie")], line: 0, end: 0 },
      {
        type: "paragraph",
        children: [text("Você é o Kelpie,\no Master.")],
        line: 2,
        end: 3,
      },
      { type: "heading", level: 2, children: [text("Como trabalha")], line: 5, end: 5 },
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          { children: [text("Pergunta só quando muda.\ne acompanha.")], line: 6 },
          { children: [text("Pede confirmação.")], line: 8 },
        ],
        line: 6,
        end: 8,
      },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [
          { children: [text("três")], line: 10 },
          { children: [text("quatro")], line: 11 },
        ],
        line: 10,
        end: 11,
      },
      { type: "quote", children: [text("Uma citação\nem duas linhas")], line: 12, end: 13 },
      { type: "rule", line: 14, end: 14 },
      { type: "code", text: "const x = '<b>';", line: 15, end: 17 },
      { type: "paragraph", children: [text("Fim ##")], line: 18, end: 18 },
    ]);
  });

  it("reads a SKILL.md's frontmatter as a block of its own, and an unclosed one as text", () => {
    const [front, heading] = readMarkdown("---\nname: pdf\ndescription: Fills.\n---\n# PDF");
    expect(front).toEqual({
      type: "frontmatter",
      text: "name: pdf\ndescription: Fills.",
      line: 0,
      end: 3,
    });
    expect(heading).toMatchObject({ type: "heading", line: 4 });
    expect(readMarkdown("---\nname: pdf")[0]).toMatchObject({ type: "rule", line: 0 });
  });

  it("closes an unclosed fence at the end, and ends a list where text resumes", () => {
    expect(readMarkdown("~~~\ncode")).toEqual([{ type: "code", text: "code", line: 0, end: 1 }]);
    const blocks = readMarkdown("- a\n1. b\ntext\n> q\n- c");
    expect(blocks.map((block) => [block.type, block.line])).toEqual([
      ["list", 0],
      ["list", 1],
      ["paragraph", 2],
      ["quote", 3],
      ["list", 4],
    ]);
    expect(readMarkdown("a\r\nb")).toEqual([
      { type: "paragraph", children: [text("a\nb")], line: 0, end: 1 },
    ]);
    expect(readMarkdown("``` `x`\n").map((block) => block.type)).toEqual(["paragraph"]);
  });

  it("reads inline code, links, emphasis and escapes, as a reply's", () => {
    expect(readInline("Run `bun test` **now**, *please* \\*not\\*")).toEqual([
      text("Run "),
      { type: "code", text: "bun test" },
      text(" "),
      { type: "bold", children: [text("now")] },
      text(", "),
      { type: "italic", children: [text("please")] },
      text(" *not*"),
    ]);
    expect(readInline("[the docs](https://example.com/a_(b)) and https://kelpie.dev/x.")).toEqual([
      { type: "link", href: "https://example.com/a_(b)", children: [text("the docs")] },
      text(" and "),
      { type: "link", href: "https://kelpie.dev/x", children: [text("https://kelpie.dev/x")] },
      text("."),
    ]);
    expect(readInline("snake_case and 2*3 and **open")).toEqual([
      text("snake_case and 2*3 and **open"),
    ]);
    expect(readInline("[]() [x](has space) [x](")).toEqual([text("[]() [x](has space) [x](")]);
    expect(readInline("http://")).toEqual([text("http://")]);
  });

  it("stays linear on input made to be slow", () => {
    const started = performance.now();
    readInline("*a ".repeat(20_000));
    readInline("[".repeat(20_000));
    readMarkdown("- x\n".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("names the marks a line opens with", () => {
    expect(lineMark("## Title")).toBe("## ");
    expect(lineMark("- item")).toBe("- ");
    expect(lineMark("12. item")).toBe("12. ");
    expect(lineMark("> quote")).toBe("> ");
    expect(lineMark("```js")).toBe("```");
    expect(lineMark("plain")).toBe("");
  });
});

describe("a file's blocks, drawn", () => {
  const draw = (source) => {
    const host = document.createElement("div");
    host.append(renderBlocks(readMarkdown(source), TEXTS.en));
    return host;
  };

  it("never parses the file as HTML, and marks each block with its lines", () => {
    const host = draw(
      '# <img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n- <b>x</b>',
    );
    expect(host.querySelector("img, script, b")).toBeNull();
    expect(host.querySelector("h3").className).toBe("md-h1");
    expect(host.querySelector("h3").dataset.line).toBe("0");
    expect(host.querySelector("p").dataset).toMatchObject({ line: "2", end: "2" });
    expect(host.querySelector("li").dataset.line).toBe("4");
  });

  it("draws quotes, rules, a frontmatter and deep headings", () => {
    const host = draw("---\nname: pdf\n---\n> said\n\n---\n###### six");
    expect(host.querySelector(".frontmatter pre code").textContent).toBe("name: pdf");
    expect(host.querySelector("blockquote").textContent).toBe("said");
    expect(host.querySelector("hr")).not.toBeNull();
    expect(host.querySelector("h6").className).toBe("md-h6");
  });
});
