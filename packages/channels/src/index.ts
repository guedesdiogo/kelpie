export type { ChannelAdapter, Destination, InboundWebhook, SendResult } from "./adapter.ts";
export {
  CAPABILITIES,
  type ChannelCapabilities,
  type Formatting,
  typingRenewIntervalMs,
} from "./capabilities.ts";
export { type CanonicalEvent, type ChannelId, dedupeKey, type MessagePart } from "./events.ts";
