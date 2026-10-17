/** The runner's own version, which `/health` reports and Claude Code's client name carries. */
export const VERSION = "0.2.0";

// By path, not through the workspace: the runner installs only its own dependencies. The file
// imports nothing, so Kelpie's side and the runner can't disagree on it.
export {
  RUNNER_PROTOCOL as PROTOCOL,
  type RunnerErrorCode,
  type RunnerFrame,
  type RunnerReply,
  type RunnerText,
  type RunnerToolCall,
  type RunnerToolResult,
  type RunnerToolSpec,
  type RunnerTurnRequest,
  type RunnerUsage,
} from "../../../packages/channels/src/runner.ts";
