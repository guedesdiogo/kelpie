/** The runner's own version, which `/health` reports. */
export const VERSION = "0.1.0";

// By path, not through the workspace: the runner runs from a checkout without `bun install`. The
// file imports nothing, so Kelpie's side and the runner can't disagree on it.
export { RUNNER_PROTOCOL as PROTOCOL } from "../../../packages/channels/src/runner.ts";
