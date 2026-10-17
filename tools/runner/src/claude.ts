import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { VERSION } from "./protocol.ts";

/**
 * The only variables of the runner's environment that Claude Code's process gets. The SDK's `env`
 * replaces the process's environment, so `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS` never reach it, and it uses the server's own
 * claude.ai login (ADR-0037 §2).
 */
export const ENV_ALLOWLIST = ["HOME", "PATH", "LANG", "TMPDIR"] as const;

/** Kelpie's in-process MCP server. Claude Code names its tools `mcp__kelpie__<name>`. */
export const SERVER_NAME = "kelpie";
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

/** The 7 model calls Kelpie's bound allows a turn (ADR-0025), plus one. */
export const MAX_TURNS = 8;

export interface SessionSettings {
  /** Kelpie's id for the session: the one a new session takes, or the one to resume. */
  id: string;
  resume: boolean;
  model: string;
  system: string;
  server: McpSdkServerConfigWithInstance;
  /** The runner's own environment, of which Claude Code gets only the allowlist. */
  env: Record<string, string | undefined>;
  /** Where Claude Code runs, and so where it keeps the session's transcript. */
  cwd: string;
  /** Claude Code's stderr, for the runner's own log only. */
  stderr: (data: string) => void;
}

/** The options of every `query()` the runner makes. */
export function sessionOptions(settings: SessionSettings): Options {
  return {
    ...(settings.resume ? { resume: settings.id } : { sessionId: settings.id }),
    model: settings.model,
    // Kelpie's prompt replaces Claude Code's.
    systemPrompt: settings.system,
    // ADR-0037 §2's isolation: no built-in tool, no settings file or CLAUDE.md, and no MCP server
    // but Kelpie's, so none of the account's claude.ai connectors.
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
    mcpServers: { [SERVER_NAME]: settings.server },
    // Kelpie's tools stay out of `allowedTools`, so each call reaches `canUseTool`.
    permissionMode: "default",
    canUseTool,
    maxTurns: MAX_TURNS,
    env: childEnv(settings.env),
    // Text streams as it comes, and a reply's end says when its round is complete.
    includePartialMessages: true,
    // The text goes as written: no `@path` expansion of a file on the server, no slash command.
    verbatimPrompts: true,
    cwd: settings.cwd,
    stderr: settings.stderr,
  };
}

/** Claude Code's environment: the allowlist, plus Kelpie's name and two switches. */
export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const child: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined) child[name] = value;
  }
  return {
    ...child,
    CLAUDE_AGENT_SDK_CLIENT_APP: `kelpie/${VERSION}`,
    // The session must hold what Kelpie's history holds: no compaction, no memory of its own.
    DISABLE_AUTO_COMPACT: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
}

/**
 * Lets only Kelpie's tools run, from the server the runner registered. Kelpie's own gates, such as
 * confirmations, run in its handlers (ADR-0026).
 */
export const canUseTool: CanUseTool = async (name, input, { mcpServer }) =>
  name.startsWith(TOOL_PREFIX) && mcpServer?.source === "sdk" && mcpServer.name === SERVER_NAME
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "Only Kelpie's own tools run here." };
