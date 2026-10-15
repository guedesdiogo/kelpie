import { describe, expect, it } from "vitest";
import { errorFromStatus } from "../src/errors.ts";

// The answers the providers document for spent credits and spend limits (#293):
// https://platform.claude.com/docs/en/api/errors, /api/rate-limits#spend-limits and
// /about-claude/api-credits-for-subscribers; https://developers.openai.com/api/docs/guides/error-codes
const anthropic = (type: string, message: string, details?: object) =>
  JSON.stringify({ type: "error", error: { type, message, ...(details ? { details } : {}) } });

describe("errorFromStatus", () => {
  it.each([
    [
      "Anthropic's billing error",
      402,
      anthropic("billing_error", "Check your payment"),
      "billing_error",
    ],
    [
      "Anthropic's spent credits",
      400,
      anthropic(
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
      "invalid_request_error",
    ],
    [
      "a spend limit the owner set on Anthropic",
      400,
      anthropic(
        "invalid_request_error",
        "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      ),
      "invalid_request_error",
    ],
    [
      "a workspace's spend limit on Anthropic",
      400,
      anthropic(
        "invalid_request_error",
        "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      ),
      "invalid_request_error",
    ],
    [
      "Anthropic's tier spend cap",
      429,
      anthropic("rate_limit_error", "You have reached your API usage limits.", {
        error_code: "enforced_spend_limit_reached",
      }),
      "rate_limit_error",
    ],
    [
      "OpenAI's spent credits",
      429,
      "429 Your organization has no prepaid credits remaining.",
      "credit_balance_exhausted",
    ],
    [
      "OpenAI's organization spend limit",
      429,
      "429 Spend limit reached.",
      "organization_spend_limit_exceeded",
    ],
    [
      "OpenAI's project spend limit",
      429,
      "429 Spend limit reached.",
      "project_spend_limit_exceeded",
    ],
    ["OpenAI's usage limit", 429, "429 Usage limit reached.", "organization_usage_limit_exceeded"],
    [
      "OpenAI's insufficient quota",
      429,
      "429 You exceeded your current quota.",
      "insufficient_quota",
    ],
  ])(
    "classifies %s as out of credits, which another route may serve",
    (_, status, message, kind) => {
      expect(errorFromStatus(status, message, kind)).toMatchObject({
        code: "out_of_credits",
        retryable: true,
        status,
      });
    },
  );

  it.each([
    [
      "an ordinary rate limit",
      429,
      anthropic("rate_limit_error", "Number of requests has exceeded your rate limit"),
      "rate_limit_error",
      "rate_limited",
    ],
    [
      "a request error",
      400,
      anthropic("invalid_request_error", "messages: field required"),
      "invalid_request_error",
      "bad_request",
    ],
    [
      "a bad key",
      401,
      anthropic("authentication_error", "invalid x-api-key"),
      "authentication_error",
      "auth",
    ],
  ])("leaves %s as it was", (_, status, message, kind, code) => {
    expect(errorFromStatus(status, message, kind)).toMatchObject({ code });
  });

  it.each([
    [408, "Request Timeout"],
    [425, "Too Early"],
  ])("takes %i as a failure another try clears (#203)", (status, message) => {
    expect(errorFromStatus(status, message, null)).toMatchObject({
      code: "server_error",
      retryable: true,
      status,
    });
  });
});
