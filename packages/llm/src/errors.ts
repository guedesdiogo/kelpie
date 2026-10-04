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
  ) {
    super(message);
  }
}

/**
 * Classifies an HTTP failure. A missing status is an error event inside an open stream, which both
 * providers use for overload and server errors.
 */
export function errorFromStatus(status: number | undefined, message: string): LlmError {
  if (status === undefined || status >= 500) return new LlmError(message, "server_error", true);
  if (status === 429) return new LlmError(message, "rate_limited", true);
  if (status === 401 || status === 403) return new LlmError(message, "auth", false);
  return new LlmError(message, "bad_request", false);
}
