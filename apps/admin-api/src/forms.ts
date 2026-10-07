import type { ChannelFormsContract } from "@kelpie/channels";

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

export async function showForm(token: string, forms: FormDeps): Promise<Response> {
  const form = await forms.describeForm(token);
  if (!form.ok) return form.reason === "unknown_form" ? closedPage() : unavailablePage();
  return page(200, "Connect Telegram", tokenForm(form.agentId, null));
}

export async function submitForm(
  token: string,
  botToken: string,
  forms: FormDeps,
): Promise<Response> {
  if (botToken.trim() === "") {
    // Nothing to check: an empty submission doesn't count against the form's attempts.
    const form = await forms.describeForm(token);
    if (!form.ok) return form.reason === "unknown_form" ? closedPage() : unavailablePage();
    return page(400, "Connect Telegram", tokenForm(form.agentId, "Paste the bot token first."));
  }
  const result = await forms.redeemTelegramForm(token, botToken);
  if (result.ok) {
    const bot = `@${escapeHtml(result.bot.username)}`;
    const agent = `<code>${escapeHtml(result.agentId)}</code>`;
    // The token is stored either way; only the webhook needs another try.
    const body =
      result.webhook === "registered"
        ? `<p>${bot} now answers for ${agent}. You can close this page.</p>`
        : `<p>${bot} is connected to ${agent}, but Telegram couldn't be pointed at Kelpie (<code>${escapeHtml(result.webhook)}</code>). Until it is, messages to the bot do not reach Kelpie. Once that is fixed, run the <code>registerTelegramWebhook</code> command for ${agent}.</p>`;
    return page(200, "Telegram connected", body);
  }
  if (result.reason === "invalid_token" || result.reason === "token_refused") {
    // A form closes after a few refused values; then the link is spent.
    const form = await forms.describeForm(token);
    if (!form.ok) return closedPage();
    const message =
      result.reason === "invalid_token"
        ? "That doesn't look like a bot token. Copy it again from BotFather."
        : "Telegram didn't accept that token. Check it in BotFather and paste it again.";
    return page(400, "Connect Telegram", tokenForm(form.agentId, message));
  }
  return result.reason === "unknown_form" ? closedPage() : unavailablePage();
}

export function closedPage(): Response {
  return page(
    404,
    "This link no longer works",
    "<p>It expired, was used, or was refused too many times. Ask for a new one.</p>",
  );
}

export function unavailablePage(): Response {
  return page(503, "Try again later", "<p>Kelpie couldn't reach its secret store.</p>");
}

/** A page with headers that keep the form out of caches, referrers and frames. */
export function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
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

function tokenForm(agentId: string, error: string | null): string {
  return `<p>Paste the token BotFather gave you for the bot that answers as <code>${escapeHtml(agentId)}</code>. It goes straight to Kelpie's secret store.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post">
  <label for="botToken">Bot token</label>
  <input id="botToken" name="botToken" type="password" autocomplete="off" spellcheck="false" maxlength="128" required>
  <button type="submit">Connect</button>
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
