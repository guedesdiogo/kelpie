import type { Actor } from "@kelpie/config";
import type { RecallOptions } from "@kelpie/context-store/contract";
import type { ToolCallPart, ToolResult, ToolSpec } from "@kelpie/llm";

// The tool layer (ADR-0014, issue #141): providers offer an agent tools, and the conversation's
// turn runs the calls its model asks for. The setup agent's configuration commands (#48) and the
// memory tools (#126) arrive as providers.

/** The most rounds of tool calls a turn runs (ADR-0025); calls past them get TOOL_BOUND_RESULT. */
export const MAX_TOOL_ROUNDS = 5;

/** What a call past the turn's bounds gets. One last call then answers, with the same tools. */
export const TOOL_BOUND_RESULT =
  "Not run: this turn reached its limit for tools. Answer now with what you have.";

/** What a call still running when the turn's time ran out gets; one last call then answers. */
export const TOOL_TIMED_OUT_RESULT =
  "Stopped: this turn ran out of time for tools before the call finished, so it may or may not have taken effect. Answer now with what you have.";

/** What a call gets when a new message or a pause stopped the turn before it started. */
export const TOOL_NOT_RUN_RESULT = "Not run: the turn stopped before this call started.";

/**
 * What a call gets when the turn stopped while it ran, or when an eviction lost its result: it may
 * have done its work, so the next turn shouldn't assume either way.
 */
export const TOOL_STOPPED_RESULT =
  "Stopped before its result came back: it may or may not have taken effect.";

/** The longest tool output kept; history holds it and every later request sends it again. */
export const TOOL_OUTPUT_MAX_CHARS = 10_000;

/** What a tool that threw gets. Its error isn't passed on: it could quote personal data. */
export const TOOL_FAILED_RESULT = "The tool failed.";

/** The reply when even the last call asks for tools again. */
export const TOOL_LIMIT_TEXT =
  "I couldn't finish this within my limits. Ask me again, or narrow it down.";

/** What a tool's run knows about the turn. None of it comes from model output. */
export interface ToolContext {
  /** Built from the turn's admitted user, `via` the agent. */
  actor: Actor;
  agentId: string;
  /** The memory scopes the turn may read, as its recall uses them. */
  scopes: RecallOptions["scopes"];
  /** The agent's qualifier, for tools that rank as recall does: Clef unless the agent chose Jev. */
  qualifier: NonNullable<RecallOptions["qualifier"]>;
  /** The turn, the same for all its calls: what a tool counts per turn is keyed by it. */
  turn: string;
  /**
   * Where the turn's words came from, for what a tool saves: the conversation, as its session
   * pages name it, and the day in its time zone.
   */
  source: string;
  /** Aborts when the turn stops: a new message, a pause or an eviction. */
  signal: AbortSignal;
}

/**
 * A tool's answer for the model. A failure is a value; the model reads `output` either way, and
 * history keeps it, so it must not carry another service's error message: those can quote personal
 * data. Past TOOL_OUTPUT_MAX_CHARS it is cut.
 */
export interface ToolOutcome {
  output: string;
  isError?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  /** Plain words the webchat shows while the tool runs, such as "Searching memory". */
  label: string;
  run(input: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolProvider {
  /**
   * The tools this provider gives an agent, none when it serves others. A turn asks once and keeps
   * the list for all its rounds; it should stay the same from turn to turn too, because a change
   * starts the provider's cache over.
   */
  tools(agentId: string): Promise<Tool[]>;
}

/** Runs one call. An unknown tool and a tool that throws are answered with an error. */
export async function runToolCall(
  tools: ReadonlyMap<string, Tool>,
  call: ToolCallPart,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = tools.get(call.name);
  if (!tool) {
    const name = call.name.slice(0, 64);
    return { callId: call.id, output: `There is no tool named ${name}.`, isError: true };
  }
  try {
    const outcome = await tool.run(call.input, context);
    const output =
      outcome.output.length > TOOL_OUTPUT_MAX_CHARS
        ? // Never half of a surrogate pair.
          `${outcome.output.slice(0, TOOL_OUTPUT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "")}\n[Cut: the result was longer.]`
        : outcome.output;
    return outcome.isError
      ? { callId: call.id, output, isError: true }
      : { callId: call.id, output };
  } catch (error) {
    // The tool's own name, never the model's input or the error's message.
    console.error("ConversationAgent: a tool failed", {
      tool: tool.spec.name,
      error: error instanceof Error ? error.name : typeof error,
    });
    return { callId: call.id, output: TOOL_FAILED_RESULT, isError: true };
  }
}
