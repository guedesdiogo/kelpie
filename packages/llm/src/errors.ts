import type { ProviderId } from "./types.ts";

export type LlmErrorCode =
  | "rate_limited"
  | "out_of_credits"
  | "server_error"
  | "connection"
  | "auth"
  | "bad_request"
  | "aborted"
  | "unavailable"
  | "protocol"
  | "internal";

/** A provider failure. `retryable` decides whether the router may try the next candidate. */
export class LlmError extends Error {
  override readonly name = "LlmError";
  /** The route that failed, set by the router, so a notice can name it (#293). */
  route?: { provider: ProviderId; model: string };

  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
    /** The provider's HTTP status, when it answered with one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

// Error kinds, from the response body, that retrying elsewhere won't fix.
const FATAL_KINDS = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "invalid_prompt",
]);

/**
 * Error kinds and codes that mean the account can't pay for the request: its credits are spent, or
 * it reached a spend limit (#293). Another route may still serve it.
 */
const OUT_OF_CREDITS_KINDS = new Set([
  // Anthropic's billing error. Its tier spend cap is a 429 known by its text, below.
  "billing_error",
  // OpenAI's codes, and the type some of them come with.
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

/**
 * Anthropic answers spent credits and a spend limit the owner set with a plain 400
 * `invalid_request_error`, so only the text tells them apart. The SDK's message carries the body,
 * so a 429's `details.error_code` is read there too.
 */
const OUT_OF_CREDITS_TEXT = [
  /Your credit balance is too low/i,
  /You have reached your specified (workspace )?API usage limits/i,
  /"error_code":\s*"enforced_spend_limit_reached"/,
];

function outOfCredits(status: number, message: string, kind?: string | null): boolean {
  if (status === 402) return true;
  if (kind && OUT_OF_CREDITS_KINDS.has(kind)) return true;
  return (
    (status === 400 || status === 429) && OUT_OF_CREDITS_TEXT.some((text) => text.test(message))
  );
}

/**
 * Classifies a provider failure. A missing status means an error event inside an open stream, so
 * the error body's kind (`overloaded_error`, `invalid_request_error`, …) decides instead.
 */
export function errorFromStatus(
  status: number | undefined,
  message: string,
  kind?: string | null,
): LlmError {
  if (status === undefined) {
    return kind && FATAL_KINDS.has(kind)
      ? new LlmError(message, "bad_request", false)
      : new LlmError(message, "server_error", true);
  }
  if (outOfCredits(status, message, kind)) {
    return new LlmError(message, "out_of_credits", true, status);
  }
  if (status >= 500) return new LlmError(message, "server_error", true, status);
  if (status === 429) return new LlmError(message, "rate_limited", true, status);
  if (status === 401 || status === 403) return new LlmError(message, "auth", false, status);
  return new LlmError(message, "bad_request", false, status);
}
