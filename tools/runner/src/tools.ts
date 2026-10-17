import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME } from "./claude.ts";
import { type RunnerToolSpec, VERSION } from "./protocol.ts";

/** Where Claude Code names the tool use a `tools/call` serves (Claude Code 2.1.302). */
const TOOL_USE_ID = "claudecode/toolUseId";

export interface ToolCall {
  /** The tool use's id, as the round's reply has it. */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
}

/**
 * Kelpie's tools as an in-process MCP server for Claude Code. They are registered on the MCP SDK's
 * low-level server: the Agent SDK's `createSdkMcpServer` and `McpServer.registerTool` take Zod
 * schemas only, and Kelpie's tools carry JSON Schema, which `tools/list` then lists unchanged.
 * `timeoutMs` is Claude Code's own limit on each call.
 */
export function kelpieServer(
  tools: readonly RunnerToolSpec[],
  run: (call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>,
  timeoutMs: number,
): McpSdkServerConfigWithInstance {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );
  const names = new Set(tools.map((tool) => tool.name));
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  mcp.server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params }, { signal }): Promise<CallToolResult> => {
      const id = params._meta?.[TOOL_USE_ID];
      // Without its tool use's id, the call can't be matched to its round.
      if (typeof id !== "string" || !names.has(params.name)) {
        return { content: [{ type: "text", text: "Kelpie can't run this call." }], isError: true };
      }
      const outcome = await run({ id, name: params.name, input: params.arguments ?? {} }, signal);
      return {
        content: [{ type: "text", text: outcome.output }],
        ...(outcome.isError ? { isError: true } : {}),
      };
    },
  );
  return { type: "sdk", name: SERVER_NAME, instance: mcp, timeout: timeoutMs };
}
