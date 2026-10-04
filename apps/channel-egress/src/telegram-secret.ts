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
