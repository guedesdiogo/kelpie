import { TELEGRAM_WEBHOOK_PATH } from "@kelpie/channels/telegram";

/** What the secret store keeps for an agent's Telegram bot. */
export interface TelegramSecret {
  botToken: string;
  /** Random per bot, given to `setWebhook`; ingress asks egress to check it. */
  webhookSecret: string;
  botId: number;
  username: string;
}

export function parseTelegramSecret(value: string): TelegramSecret | null {
  try {
    const parsed = JSON.parse(value) as Partial<TelegramSecret>;
    return typeof parsed.botToken === "string" && typeof parsed.webhookSecret === "string"
      ? (parsed as TelegramSecret)
      : null;
  } catch {
    return null;
  }
}

/**
 * Where Telegram sends an agent's updates: ingress's public origin (`INGRESS_ORIGIN`, set when
 * deploying), then the webhook path. Anything but a bare https origin gives null, so a mistyped
 * value registers nothing.
 */
export function telegramWebhookUrl(origin: string, agentId: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const bare =
    url.protocol === "https:" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  return bare ? `${url.origin}${TELEGRAM_WEBHOOK_PATH}/${agentId}` : null;
}
