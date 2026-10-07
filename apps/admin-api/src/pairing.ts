import { escapeHtml, page } from "./forms.ts";

// The page that pairs the owner's Telegram account with an agent's bot (Story 3.11). The setup
// agent links to it, because pairing needs the Directory, which only the admin API and ingress
// bind. Pressing its button, behind Access and the owner check, is the owner's own yes.

/** The agent id in a `/pair/telegram/<agent id>` path, or null when the path isn't one. */
export function pairingAgentOf(pathname: string): string | null {
  return pathname.startsWith("/pair/telegram/") ? pathname.slice("/pair/telegram/".length) : null;
}

export function pairingPage(agent: { id: string; name: string }): Response {
  return page(
    200,
    "Pair Telegram",
    `<p>Pair your own Telegram account with the bot of ${escapeHtml(agent.name)} (<code>${escapeHtml(agent.id)}</code>). You get a link to open in Telegram, where you are logged in; the account that opens it becomes yours in Kelpie.</p>
<form method="post">
  <button type="submit">Get the link</button>
</form>`,
  );
}

export function pairedPage(link: string, expiresAt: number): Response {
  return page(
    200,
    "Pair Telegram",
    `<p>Open <a href="${escapeHtml(link)}" rel="noreferrer">this link</a> in Telegram and press Start. It works once, until ${escapeHtml(new Date(expiresAt).toISOString())}, and a new one replaces it.</p>`,
  );
}

export function notConnectedPage(): Response {
  return page(
    409,
    "No bot yet",
    "<p>Connect the agent's Telegram bot first: ask the setup agent, or run the <code>connectTelegram</code> command.</p>",
  );
}

export function noAgentPage(): Response {
  return page(404, "No such agent", "<p>Check the link, or ask the setup agent for a new one.</p>");
}
