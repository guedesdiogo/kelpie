import type {
  RunnerText,
  RunnerToolResult,
  RunnerToolSpec,
  RunnerTurnRequest,
} from "./protocol.ts";

/** A session's id in a path: a lowercase UUID, as Kelpie picks them and Claude Code takes them. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A seed carries a conversation's transcript, its checkpoint included. */
export const MAX_TURN_BYTES = 8 * 1024 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;

const MAX_CONVERSATION_CHARS = 256;
const MAX_SYSTEM_CHARS = 200_000;
const MAX_TOOLS = 128;
const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_MESSAGES = 1_000;
const MAX_PARTS = 1_000;
const MAX_CALL_ID_CHARS = 256;
/** llm-gateway's own bound on an answer. The runner then cuts it as Kelpie's tools do. */
const MAX_OUTPUT_CHARS = 20_000;
const MIN_TOOL_LOOP_MS = 1_000;
const MAX_TOOL_LOOP_MS = 3_600_000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;
/** The Messages API's rule for a tool's name. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A request body as JSON, read up to `maxBytes`; or the status that refuses it. */
export async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ value: unknown } | { status: 400 | 413 }> {
  if (Number(request.headers.get("content-length")) > maxBytes) return { status: 413 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { status: 413 };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { status: 400 };
  }
}

/** A turn's body, checked field by field: anything else, or anything more, is refused. */
export function parseTurnRequest(value: unknown): RunnerTurnRequest | null {
  if (
    !hasKeys(value, [
      "conversation",
      "resume",
      "model",
      "system",
      "tools",
      "messages",
      "toolLoopMs",
    ])
  ) {
    return null;
  }
  const { conversation, resume, model, system, tools, messages, toolLoopMs } = value;
  if (!isText(conversation, MAX_CONVERSATION_CHARS) || typeof resume !== "boolean") return null;
  if (typeof model !== "string" || !MODEL.test(model) || !isText(system, MAX_SYSTEM_CHARS)) {
    return null;
  }
  if (
    typeof toolLoopMs !== "number" ||
    !Number.isInteger(toolLoopMs) ||
    toolLoopMs < MIN_TOOL_LOOP_MS ||
    toolLoopMs > MAX_TOOL_LOOP_MS
  ) {
    return null;
  }
  const specs = parseTools(tools);
  const sent = parseMessages(messages);
  if (specs === null || sent === null) return null;
  return {
    conversation,
    resume,
    model,
    system,
    tools: specs,
    messages: sent,
    toolLoopMs,
  };
}

/** A tool call's result, as llm-gateway checks it. */
export function parseToolResult(value: unknown): RunnerToolResult | null {
  if (!hasKeys(value, ["callId", "output"], ["isError"])) return null;
  const { callId, output, isError } = value;
  if (!isText(callId, MAX_CALL_ID_CHARS)) return null;
  if (typeof output !== "string" || output.length > MAX_OUTPUT_CHARS) return null;
  if (isError !== undefined && typeof isError !== "boolean") return null;
  return { callId, output, ...(isError === undefined ? {} : { isError }) };
}

function parseTools(value: unknown): RunnerToolSpec[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return null;
  const names = new Set<string>();
  const specs: RunnerToolSpec[] = [];
  for (const entry of value) {
    if (!hasKeys(entry, ["name", "description", "inputSchema"])) return null;
    const { name, description, inputSchema } = entry;
    if (typeof name !== "string" || !TOOL_NAME.test(name) || names.has(name)) return null;
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) return null;
    if (!isObject(inputSchema) || inputSchema.type !== "object") return null;
    names.add(name);
    specs.push({ name, description, inputSchema: inputSchema as RunnerToolSpec["inputSchema"] });
  }
  return specs;
}

function parseMessages(value: unknown): RunnerTurnRequest["messages"] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages: RunnerTurnRequest["messages"] = [];
  for (const entry of value) {
    if (!hasKeys(entry, ["role", "parts"]) || entry.role !== "user") return null;
    const { parts } = entry;
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) return null;
    const texts: RunnerText[] = [];
    for (const part of parts) {
      if (!hasKeys(part, ["type", "text"]) || part.type !== "text") return null;
      // The Messages API refuses an empty text block. The body's size bounds the text.
      if (typeof part.text !== "string" || part.text === "") return null;
      texts.push({ type: "text", text: part.text });
    }
    messages.push({ role: "user", parts: texts });
  }
  return messages;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with every required key, and no key outside `required` and `optional`. */
function hasKeys<K extends string, O extends string = never>(
  value: unknown,
  required: readonly K[],
  optional: readonly O[] = [],
): value is Record<K, unknown> & Partial<Record<O, unknown>> {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every(
      (key) =>
        (required as readonly string[]).includes(key) ||
        (optional as readonly string[]).includes(key),
    )
  );
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
