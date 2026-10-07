export type LlmErrorCode =
  | "rate_limited"
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
  if (status >= 500) return new LlmError(message, "server_error", true, status);
  if (status === 429) return new LlmError(message, "rate_limited", true, status);
  if (status === 401 || status === 403) return new LlmError(message, "auth", false, status);
  return new LlmError(message, "bad_request", false, status);
}
