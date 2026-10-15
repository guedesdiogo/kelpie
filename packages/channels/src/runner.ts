// What Kelpie and its VPS runner say to each other (ADR-0035, #294). This file imports nothing, so
// the runner, which runs from a checkout without `bun install`, imports it by path.

/** The protocol's version. It changes when a request or an answer changes shape. */
export const RUNNER_PROTOCOL = 1;

/** A version as the runner reports it, such as `0.1.0`; anything else isn't the runner's answer. */
export const RUNNER_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * The runner as `channel-egress` sees it, never with its secret:
 * - `not_configured`: `channel-egress` was deployed without the runner's VPC Service;
 * - `not_connected`: no secret was given through the secure form;
 * - `refused`: the runner answers 401 to the stored secret;
 * - `unreachable`: the call failed or timed out, or the answer isn't the runner's;
 * - `ready`, or `outdated` when it speaks another protocol version.
 */
export type RunnerState =
  | { state: "ready" | "outdated"; version: string; protocol: number }
  | { state: "not_configured" | "not_connected" | "refused" | "unreachable" };

/** A runner that answered its `/health`. */
export type RunnerAnswered = Extract<RunnerState, { version: string }>;
