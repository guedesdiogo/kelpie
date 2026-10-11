import type { Locale } from "@kelpie/channels";
import { escapeHtml, page } from "./forms.ts";
import { PAGES } from "./texts.ts";

// The page that pairs the owner's Telegram account with an agent's bot (Story 3.11). The setup
// agent links to it, because pairing needs the Directory, which only the admin API and ingress
// bind. Pressing its button, behind Access and the owner check, is the owner's own yes.

/** The agent id in a `/pair/telegram/<agent id>` path, or null when the path isn't one. */
export function pairingAgentOf(pathname: string): string | null {
  return pathname.startsWith("/pair/telegram/") ? pathname.slice("/pair/telegram/".length) : null;
}

/** The page's button posts to its own URL, so the answer keeps the link's `?lang=`. */
export function pairingPage(agent: { id: string; name: string }, locale: Locale): Response {
  const texts = PAGES[locale].pair;
  const intro = texts.intro(escapeHtml(agent.name), `<code>${escapeHtml(agent.id)}</code>`);
  return page(
    200,
    texts.title,
    `<p>${intro}</p>
<form method="post">
  <button type="submit">${texts.button}</button>
</form>`,
    locale,
  );
}

/** The `t.me` link, and how long it lasts: a duration, so no time zone is involved. */
export function pairedPage(link: string, expiresAt: number, now: number, locale: Locale): Response {
  const texts = PAGES[locale].pair;
  const minutes = Math.max(Math.round((expiresAt - now) / 60_000), 1);
  return page(200, texts.title, `<p>${texts.open(escapeHtml(link), minutes)}</p>`, locale);
}

export function notConnectedPage(locale: Locale): Response {
  const texts = PAGES[locale].noBot;
  return page(409, texts.title, `<p>${texts.body}</p>`, locale);
}

export function noAgentPage(locale: Locale): Response {
  const texts = PAGES[locale].noAgent;
  return page(404, texts.title, `<p>${texts.body}</p>`, locale);
}
