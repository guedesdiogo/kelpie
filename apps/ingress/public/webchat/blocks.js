// A reply's formatting (#188), built with createElement: model output is never parsed as HTML.
// The blocks are the ones the runtime read, and its links the ones it allowed; only web links
// become anchors. Each link shows its host, so a label the model wrote can't hide where it goes,
// and each code block has a Copy button (docs/design-system.md §5.20). An agent's own files (#381)
// add headings, quotes, rules and a skill's frontmatter, and each block names its source lines, so
// the editor can keep the place when it switches views.

/** A reply's or a file's blocks as elements. Anything not one of the known kinds is left out. */
export function renderBlocks(blocks, texts) {
  const fragment = document.createDocumentFragment();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const made = renderBlock(block, texts);
    if (!made) continue;
    if (Number.isInteger(block.line)) {
      made.dataset.line = String(block.line);
      made.dataset.end = String(Number.isInteger(block.end) ? block.end : block.line);
    }
    fragment.append(made);
  }
  return fragment;
}

function renderBlock(block, texts) {
  switch (block?.type) {
    case "paragraph": {
      const paragraph = document.createElement("p");
      paragraph.append(renderInline(block.children, texts));
      return paragraph;
    }
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && Number.isInteger(block.start)) list.start = block.start;
      for (const item of Array.isArray(block.items) ? block.items : []) {
        const entry = document.createElement("li");
        // A reply's item is its inline nodes; a file's names its line too.
        entry.append(renderInline(Array.isArray(item) ? item : item?.children, texts));
        if (Number.isInteger(item?.line)) entry.dataset.line = String(item.line);
        list.append(entry);
      }
      return list;
    }
    case "code":
      return codeBlock(String(block.text ?? ""), texts);
    case "heading": {
      // The editor's title is the dialog's heading, so a file's own start below it.
      const level = Math.min(6, Math.max(1, Number(block.level) || 1));
      const heading = document.createElement(`h${Math.min(6, level + 2)}`);
      heading.className = `md-h${level}`;
      heading.append(renderInline(block.children, texts));
      return heading;
    }
    case "quote": {
      const quote = document.createElement("blockquote");
      quote.append(renderInline(block.children, texts));
      return quote;
    }
    case "rule":
      return document.createElement("hr");
    case "frontmatter": {
      const box = document.createElement("div");
      box.className = "frontmatter";
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.dir = "ltr";
      code.textContent = String(block.text ?? "");
      pre.append(code);
      box.append(pre);
      return box;
    }
    default:
      return null;
  }
}

export function renderInline(nodes, texts) {
  const fragment = document.createDocumentFragment();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    switch (node?.type) {
      case "text":
        fragment.append(String(node.text ?? ""));
        break;
      case "code": {
        const code = document.createElement("code");
        code.dir = "ltr";
        code.textContent = String(node.text ?? "");
        fragment.append(code);
        break;
      }
      case "bold":
      case "italic": {
        const emphasis = document.createElement(node.type === "bold" ? "strong" : "em");
        emphasis.append(renderInline(node.children, texts));
        fragment.append(emphasis);
        break;
      }
      case "link": {
        const label = renderInline(node.children, texts);
        const url = webLink(node.href);
        if (!url) {
          fragment.append(label);
          break;
        }
        fragment.append(link(url, label, texts));
        break;
      }
    }
  }
  return fragment;
}

/** The link's address as a URL, for web links only. */
export function webLink(href) {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The host a link shows after its text, without a leading "www.". */
export function shownHost(url) {
  return url.hostname.replace(/^www\./, "");
}

function link(url, label, texts) {
  const anchor = document.createElement("a");
  anchor.href = url.href;
  anchor.title = url.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.append(label);
  const host = document.createElement("span");
  host.className = "link-host";
  host.textContent = shownHost(url);
  const arrow = document.createElement("span");
  arrow.className = "link-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↗";
  const newTab = document.createElement("span");
  newTab.className = "visually-hidden";
  newTab.textContent = ` ${texts.newTab}`;
  anchor.append(host, arrow, newTab);
  return anchor;
}

/** How long "Copied" stays before the button reads "Copy" again. */
export const COPIED_SHOWN_MS = 1_500;

function codeBlock(text, texts) {
  const figure = document.createElement("div");
  figure.className = "code";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.dir = "ltr";
  code.textContent = text;
  pre.append(code);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = texts.copy;
  let reset = null;
  copy.addEventListener("click", async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // The label says so.
    }
    copy.textContent = copied ? texts.copied : texts.copyFailed;
    copy.dataset.state = copied ? "copied" : "failed";
    clearTimeout(reset);
    reset = setTimeout(() => {
      copy.textContent = texts.copy;
      delete copy.dataset.state;
    }, COPIED_SHOWN_MS);
  });
  figure.append(pre, copy);
  return figure;
}
