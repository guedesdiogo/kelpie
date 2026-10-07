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
export type {
  ChannelEgressContract,
  ChannelFormsContract,
  ChannelWebhooksContract,
  DeliveryFailure,
  EgressDestination,
  SendOutcome,
  SetupFormsContract,
  TypingOutcome,
  WebhookNotice,
  WebhookRegistration,
  WebhookRegistrationFailure,
} from "./egress.ts";
export { type CanonicalEvent, type ChannelId, dedupeKey, type MessagePart } from "./events.ts";
export {
  type AllowedLinks,
  type Block,
  formatReply,
  type Inline,
  linksOf,
  trimUrl,
} from "./markdown.ts";

// Adapters have their own entry points (`@kelpie/channels/telegram`): they need the runtime's fetch
// and crypto, which packages that only use the types above don't declare.
