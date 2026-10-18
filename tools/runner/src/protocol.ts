/** The runner's own version, which `/health` reports and Claude Code's client name carries. */
export const VERSION = "0.3.0";

// By path, not through the workspace: the runner installs only its own dependencies. The file
// imports nothing, so Kelpie's side and the runner can't disagree on it.
export {
  parseRunnerToolResult as parseToolResult,
  parseRunnerTurnRequest as parseTurnRequest,
  RUNNER_ENTRYPOINT as ENTRYPOINT,
  RUNNER_MAX_BRANCH_CHARS as MAX_BRANCH_CHARS,
  RUNNER_MAX_EXCERPT_CHARS as MAX_EXCERPT_CHARS,
  RUNNER_MAX_REPOSITORY_CHARS as MAX_REPOSITORY_CHARS,
  RUNNER_MAX_RESULT_BYTES as MAX_RESULT_BYTES,
  RUNNER_MAX_SESSIONS_BYTES as MAX_SESSIONS_BYTES,
  RUNNER_MAX_TITLE_CHARS as MAX_TITLE_CHARS,
  RUNNER_MAX_TURN_BYTES as MAX_TURN_BYTES,
  RUNNER_MAX_VPS_SESSIONS as MAX_VPS_SESSIONS,
  RUNNER_MAX_WAITS_BYTES as MAX_WAITS_BYTES,
  RUNNER_NOT_ONE_LINE as NOT_ONE_LINE,
  RUNNER_PR_URL as PR_URL,
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
  type RunnerVpsSession,
  type RunnerVpsSessions,
  type RunnerVpsState,
  type RunnerVpsStatus,
  type RunnerVpsWait,
  type RunnerVpsWaits,
} from "../../../packages/channels/src/runner.ts";
