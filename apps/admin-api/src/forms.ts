import type { ChannelFormsContract, Locale } from "@kelpie/channels";
import { PAGES } from "./texts.ts";

// The one-time secure forms (ADR-0013) where the owner pastes a channel's secret, such as a
// Telegram bot token. The page is served by the admin API behind Access; the secret goes straight
// to channel-egress and never into a conversation, a log or a response.

export type FormDeps = Pick<ChannelFormsContract, "describeForm" | "redeemTelegramForm">;

/** A form token as channel-egress issues it: base64url, at most 64 characters. */
const FORM_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** The form token in a `/forms/<token>` path, or null when the path isn't one. */
export function formTokenOf(pathname: string): string | null {
  if (!pathname.startsWith("/forms/")) return null;
  const token = pathname.slice("/forms/".length);
  return FORM_TOKEN.test(token) ? token : null;
}

export async function showForm(token: string, forms: FormDeps, locale: Locale): Promise<Response> {
  const form = await forms.describeForm(token);
  if (!form.ok) return formGone(form, locale);
  return page(200, PAGES[locale].connect.title, tokenForm(form.agentId, null, locale), locale);
}

type Gone = Extract<Awaited<ReturnType<FormDeps["describeForm"]>>, { ok: false }>;

/** A form that isn't open: used a moment ago, closed, or unreachable. */
function formGone(form: Gone, locale: Locale): Response {
  if (form.reason === "redeemed") {
    const texts = PAGES[locale].connected;
    const bot = `@${escapeHtml(form.username)}`;
    const agent = `<code>${escapeHtml(form.agentId)}</code>`;
    return page(200, texts.title, `<p>${texts.used(bot, agent)}</p>`, locale);
  }
  return form.reason === "unknown_form" ? closedPage(locale) : unavailablePage(locale);
}

export async function submitForm(
  token: string,
  botToken: string,
  forms: FormDeps,
  locale: Locale,
): Promise<Response> {
  const texts = PAGES[locale];
  if (botToken.trim() === "") {
    // Nothing to check: an empty submission doesn't count against the form's attempts.
    const form = await forms.describeForm(token);
    if (!form.ok) return formGone(form, locale);
    const body = tokenForm(form.agentId, texts.connect.empty, locale);
    return page(400, texts.connect.title, body, locale);
  }
  const result = await forms.redeemTelegramForm(token, botToken);
  if (result.ok) {
    const bot = `@${escapeHtml(result.bot.username)}`;
    const agent = `<code>${escapeHtml(result.agentId)}</code>`;
    // The token is stored either way; only the webhook needs another try.
    const body =
      result.webhook === "registered"
        ? `<p>${texts.connected.done(bot, agent)}</p>`
        : `<p>${texts.connected.noWebhook(bot, agent, `<code>${escapeHtml(result.webhook)}</code>`)}</p>`;
    return page(200, texts.connected.title, body, locale);
  }
  if (result.reason === "invalid_token" || result.reason === "token_refused") {
    // A form closes after a few refused values; then the link is spent.
    const form = await forms.describeForm(token);
    if (!form.ok) return form.reason === "redeemed" ? formGone(form, locale) : closedPage(locale);
    const message =
      result.reason === "invalid_token" ? texts.connect.invalid : texts.connect.refused;
    return page(400, texts.connect.title, tokenForm(form.agentId, message, locale), locale);
  }
  return result.reason === "unknown_form" ? closedPage(locale) : unavailablePage(locale);
}

export function closedPage(locale: Locale): Response {
  const texts = PAGES[locale].closed;
  return page(404, texts.title, `<p>${texts.body}</p>`, locale);
}

export function unavailablePage(locale: Locale): Response {
  const texts = PAGES[locale].unavailable;
  return page(503, texts.title, `<p>${texts.body}</p>`, locale);
}

/**
 * A page in `locale`, with headers that keep the form out of caches, referrers and frames. `title`
 * is escaped; `body` is HTML, with whatever came from elsewhere already escaped.
 */
export function page(status: number, title: string, body: string, locale: Locale): Response {
  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Kelpie</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; color: #1a1a1a; background: #fafafa; }
  main { max-width: 32rem; margin: 10vh auto; background: #fff; padding: 24px; border-radius: 12px; border: 1px solid #e5e5e5; }
  label, input, button { display: block; width: 100%; box-sizing: border-box; }
  input { font: inherit; padding: 10px; margin: 8px 0 16px; border: 1px solid #ccc; border-radius: 8px; }
  button { font: inherit; padding: 10px; border: 0; border-radius: 8px; background: #1a1a1a; color: #fff; cursor: pointer; }
  .error { color: #b00020; }
  @media (prefers-color-scheme: dark) {
    body { color: #eee; background: #111; }
    main { background: #1c1c1c; border-color: #333; }
    input { background: #111; color: #eee; border-color: #444; }
    button { background: #eee; color: #111; }
    .error { color: #ff6b81; }
  }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The URL carries the form token: it never goes to another origin. Not `no-referrer`, which
      // makes the browser send `Origin: null` with the form's own submission.
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

/** The form, which posts to its own URL, so the answer keeps the link's `?lang=`. */
function tokenForm(agentId: string, error: string | null, locale: Locale): string {
  const texts = PAGES[locale].connect;
  return `<p>${texts.intro(`<code>${escapeHtml(agentId)}</code>`)}</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post">
  <label for="botToken">${texts.label}</label>
  <input id="botToken" name="botToken" type="password" autocomplete="off" spellcheck="false" maxlength="128" required>
  <button type="submit">${texts.button}</button>
</form>`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
