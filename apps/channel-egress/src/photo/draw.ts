import type { Mascot } from "@kelpie/config";
import mascotCss from "./webchat/mascot.css.txt";
import engine from "./webchat/mascot.js.txt";
import art from "./webchat/mascot-art.js.txt";
import photo from "./webchat/mascot-photo.js.txt";
import states from "./webchat/mascot-states.js.txt";
import tokens from "./webchat/tokens.css.txt";

// The bot's photo, drawn by Browser Run (ADR-0046): one page runs the webchat's own mascot engine
// and mascot-photo.js, and answers with a still JPG and a looping MP4. The files are links to the
// webchat's, so the photo is always the mascot the owner sees there.

/** The webchat's modules, each before the ones that import it. */
export const MODULES: [name: string, text: string][] = [
  ["mascot-states.js", states],
  ["mascot-art.js", art],
  ["mascot.js", engine],
  ["mascot-photo.js", photo],
];
/** The webchat's tokens, which the mascot's stylesheet uses too, then that stylesheet. */
const CSS = `${tokens}\n${mascotCss}`;
/** The square around the figure: the design system's page background (`--bg`, light). */
const BACKGROUND = "#e7eeec";
/** The page has this long to answer; the loop takes 10 to 16 s (#368). */
const WAIT_MS = 50_000;
/** Larger than any photo the page draws, which is about 0.5 MB. */
const MAX_BYTES = 10 * 1024 * 1024;
/** The page's HTML, with both photos in base64 and the modules it ran: about 1 MB. */
const MAX_ANSWER_CHARS = 4 * MAX_BYTES;
/**
 * The page reaches nothing outside itself: its modules and fur are blob and data URLs. It holds no
 * secret either, so this only keeps a future bug in the engine from sending anything out.
 */
const PAGE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src blob: data:; connect-src blob: data:";

/** What draws the page: Browser Run's binding, or a stand-in. */
export interface PhotoBrowser {
  quickAction(action: "content", options: object): Promise<Response>;
}

export interface Photos {
  still: Uint8Array<ArrayBuffer>;
  /** Null when the browser couldn't record the loop. */
  loop: Uint8Array<ArrayBuffer> | null;
}

/** JSON inside a script element: no `<` can end the element early. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The page that draws `mascot`. It loads each module from a blob URL, with its imports pointed at
 * the others', then writes its answer in `#photo` and marks the body done.
 */
export function photoPage(mascot: Mascot): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><style>${CSS}</style>
<style>html, body { margin: 0; overflow: hidden; } #mascot { position: absolute; }</style></head>
<body><span id="mascot"></span><pre id="photo"></pre>
<script type="application/json" id="modules">${scriptJson(Object.fromEntries(MODULES))}</script>
<script type="module">
const modules = JSON.parse(document.getElementById("modules").textContent);
const urls = {};
for (const name of ${scriptJson(MODULES.map(([name]) => name))}) {
  const text = modules[name].replace(/from "\\.\\/([\\w-]+\\.js)"/g, (_, dep) => "from " + JSON.stringify(urls[dep]));
  urls[name] = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
}
const out = document.getElementById("photo");
try {
  const [engine, photo] = await Promise.all([import(urls["mascot.js"]), import(urls["mascot-photo.js"])]);
  const host = document.getElementById("mascot");
  const at = (photo.PHOTO_PX - photo.FIGURE_PX) / 2 + "px";
  Object.assign(host.style, { left: at, top: at, width: photo.FIGURE_PX + "px", height: photo.FIGURE_PX + "px" });
  const drawn = await photo.drawPhoto({ engine, host, mascot: ${scriptJson(mascot)}, css: ${scriptJson(CSS)}, background: ${scriptJson(BACKGROUND)} });
  out.textContent = JSON.stringify({ still: await photo.toBase64(drawn.still), loop: drawn.loop && (await photo.toBase64(drawn.loop)) });
} catch (error) {
  out.textContent = JSON.stringify({ error: String(error?.message ?? error).slice(0, 200) });
}
document.body.dataset.done = "1";
</script></body></html>`;
}

/**
 * Has `browser` draw `mascot`. Throws when the page fails or answers with no still, so the caller
 * can try again; a page that couldn't record the loop still has its still.
 */
export async function drawPhotos(browser: PhotoBrowser, mascot: Mascot): Promise<Photos> {
  const response = await browser.quickAction("content", {
    html: photoPage(mascot),
    viewport: { width: 800, height: 800 },
    waitForSelector: { selector: "body[data-done]", timeout: WAIT_MS },
  });
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: unknown;
  } | null;
  if (!response.ok || body?.success !== true || typeof body.result !== "string") {
    throw new Error(`Browser Run answered ${response.status}`);
  }
  if (body.result.length > MAX_ANSWER_CHARS) throw new Error("The photo page answered too much");
  const answer = answerOf(body.result);
  if ("error" in answer) throw new Error(`The photo page failed: ${answer.error}`);
  return answer;
}

/** The page's answer, from the HTML Browser Run returns. */
function answerOf(html: string): Photos | { error: string } {
  const found = /<pre id="photo">([^<]*)<\/pre>/.exec(html);
  if (!found?.[1]) return { error: "no answer" };
  let parsed: { still?: unknown; loop?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(unescapeText(found[1]));
  } catch {
    return { error: "an answer that isn't JSON" };
  }
  if (typeof parsed.error === "string") return { error: parsed.error };
  const still = bytesOf(parsed.still, JPEG);
  if (!still) return { error: "no still" };
  return { still, loop: bytesOf(parsed.loop, MP4) };
}

/** A JPG starts with its SOI marker and a segment; an MP4 with a box, then `ftyp`. */
const JPEG = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const MP4 = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp";

function bytesOf(
  value: unknown,
  looksRight: (bytes: Uint8Array) => boolean,
): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || value === "" || value.length > (MAX_BYTES * 4) / 3) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return looksRight(bytes) ? bytes : null;
}

/** Text as the HTML Browser Run returns it, with `&`, `<` and `>` escaped. */
const unescapeText = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
