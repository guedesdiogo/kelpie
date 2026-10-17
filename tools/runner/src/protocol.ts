/** The runner's own version, which `/health` reports and Claude Code's client name carries. */
export const VERSION = "0.2.0";

// By path, not through the workspace: the runner installs only its own dependencies. The file
// imports nothing, so Kelpie's side and the runner can't disagree on it.
export {
  parseRunnerToolResult as parseToolResult,
  parseRunnerTurnRequest as parseTurnRequest,
  RUNNER_MAX_RESULT_BYTES as MAX_RESULT_BYTES,
  RUNNER_MAX_TURN_BYTES as MAX_TURN_BYTES,
  RUNNER_PROTOCOL as PROTOCOL,
  RUNNER_SESSION_ID as SESSION_ID,
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
