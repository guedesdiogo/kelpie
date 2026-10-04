export {
  type ChannelAdapter,
  ChannelRateLimitedError,
  ChannelRequestError,
  type Destination,
  type InboundWebhook,
  InvalidWebhookError,
  RecipientUnavailableError,
  type SendOptions,
  type SendResult,
} from "./adapter.ts";
export {
  CAPABILITIES,
  type ChannelCapabilities,
  type Formatting,
  typingRenewIntervalMs,
} from "./capabilities.ts";
export { type CanonicalEvent, type ChannelId, dedupeKey, type MessagePart } from "./events.ts";
export { TelegramAdapter, type TelegramConfig } from "./telegram.ts";
