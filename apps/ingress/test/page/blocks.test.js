import { afterEach, describe, expect, it, vi } from "vitest";
import { COPIED_SHOWN_MS, renderBlocks, shownHost, webLink } from "../../public/webchat/blocks.js";
import { TEXTS } from "../../public/webchat/texts.js";

const T = TEXTS.en;
const render = (blocks) => {
  const host = document.createElement("div");
  host.append(renderBlocks(blocks, T));
  return host;
};
const text = (value) => ({ type: "text", text: value });

afterEach(() => {
  vi.useRealTimers();
});

describe("a reply's blocks (#188)", () => {
  it("never parses model output as HTML", () => {
    const host = render([
      { type: "paragraph", children: [text('<img src=x onerror="alert(1)">')] },
      { type: "code", text: "<script>alert(1)</script>" },
      { type: "list", ordered: false, items: [[text("<b>bold?</b>")]] },
    ]);
    expect(host.querySelector("img, script, b")).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(host.querySelector("pre code").textContent).toBe("<script>alert(1)</script>");
  });

  it("builds paragraphs, lists, emphasis and code, and leaves out what it doesn't know", () => {
    const host = render([
      {
        type: "paragraph",
        children: [
          text("Run "),
          { type: "code", text: "bun test" },
          text(" "),
          { type: "bold", children: [text("now")] },
          { type: "italic", children: [text(" please")] },
          { type: "unknown", text: "dropped" },
        ],
      },
      { type: "list", ordered: true, start: 3, items: [[text("three")], [text("four")]] },
      { type: "table", rows: [] },
      null,
    ]);
    expect(host.querySelector("p code").textContent).toBe("bun test");
    expect(host.querySelector("p code").dir).toBe("ltr");
    expect(host.querySelector("strong").textContent).toBe("now");
    expect(host.querySelector("em").textContent).toBe(" please");
    expect(host.textContent).not.toContain("dropped");
    const list = host.querySelector("ol");
    expect(list.start).toBe(3);
    expect([...list.children].map((item) => item.textContent)).toEqual(["three", "four"]);
    expect(render("not blocks").childNodes).toHaveLength(0);
  });

  it("shows where a link goes, opens it in a new tab, and says so to screen readers", () => {
    const host = render([
      {
        type: "paragraph",
        children: [
          { type: "link", href: "https://www.example.com/a?b=c", children: [text("the docs")] },
        ],
      },
    ]);
    const link = host.querySelector("a");
    expect(link.href).toBe("https://www.example.com/a?b=c");
    expect(link.title).toBe("https://www.example.com/a?b=c");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.querySelector(".link-host").textContent).toBe(" example.com");
    expect(link.querySelector(".link-arrow").getAttribute("aria-hidden")).toBe("true");
    expect(link.querySelector(".visually-hidden").textContent).toBe(" (opens in a new tab)");
  });

  it("links only web addresses; any other keeps its text and no anchor", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,hi", "mailto:a@b.c", "not a url"]) {
      const host = render([
        { type: "paragraph", children: [{ type: "link", href, children: [text("click")] }] },
      ]);
      expect(host.querySelector("a"), href).toBeNull();
      expect(host.textContent).toBe("click");
    }
    expect(webLink("http://example.com")?.hostname).toBe("example.com");
    expect(shownHost(new URL("https://www.kelpie.dev"))).toBe("kelpie.dev");
  });

  it("copies a code block, and says so in place", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const host = render([{ type: "code", text: "echo hi" }]);
    const copy = host.querySelector("button.copy");
    expect(copy.textContent).toBe("Copy");

    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("echo hi");
    expect(copy.dataset.state).toBe("copied");
    vi.advanceTimersByTime(COPIED_SHOWN_MS);
    expect(copy.textContent).toBe("Copy");
    expect(copy.dataset.state).toBeUndefined();

    writeText.mockRejectedValueOnce(new Error("denied"));
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe("Couldn't copy"));
    expect(copy.dataset.state).toBe("failed");
  });
});
