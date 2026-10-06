import OpenAI from "openai";
import { LlmError } from "./errors.ts";
import { toLlmError } from "./openai.ts";

/** The embedding services an instance can choose between (issue #110). */
export const EMBEDDING_PROVIDERS = ["workers-ai", "openai"] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * A text is cut to this many characters before it is embedded. Both models take 8,192 tokens at
 * most, and a character is rarely more than a token, so the cut stays under that in any script.
 * A note's start says what it is about.
 */
export const EMBEDDING_INPUT_CHARS = 6_000;
/**
 * One request holds at most this many characters: OpenAI takes 300,000 tokens per request, summed
 * over its inputs.
 */
export const EMBEDDING_BATCH_CHARS = 100_000;

/** Turns texts into vectors, one per text, in order. */
export interface Embedder {
  readonly provider: EmbeddingProviderId;
  /** The model, which keys stored vectors: another model means other vectors. */
  readonly model: string;
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

/** What llm-gateway's `embed` answers: the vectors and their model, or why there are none. */
export type EmbedOutcome =
  | { ok: true; model: string; vectors: number[][] }
  | { ok: false; reason: "not_configured" | "invalid" | "failed" };

/** A text's start, never half of an emoji's surrogate pair. */
function cut(text: string): string {
  if (text.length <= EMBEDDING_INPUT_CHARS) return text;
  const last = text.charCodeAt(EMBEDDING_INPUT_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? EMBEDDING_INPUT_CHARS - 1 : EMBEDDING_INPUT_CHARS;
  return text.slice(0, end);
}

const protocol = (message: string) => new LlmError(message, "protocol", false);

/**
 * Embeds texts in batches of at most `size` texts and `EMBEDDING_BATCH_CHARS` characters. Every
 * answer must be one vector per text, each of the same length, of finite numbers.
 */
async function inBatches(
  texts: readonly string[],
  size: number,
  embedBatch: (batch: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  let dims: number | null = null;
  let start = 0;
  while (start < texts.length) {
    const batch: string[] = [];
    let chars = 0;
    for (let i = start; i < texts.length && batch.length < size; i += 1) {
      const text = cut(texts[i] ?? "");
      if (batch.length > 0 && chars + text.length > EMBEDDING_BATCH_CHARS) break;
      batch.push(text);
      chars += text.length;
    }
    const answer = await embedBatch(batch);
    if (answer.length !== batch.length) {
      throw protocol("the embedding service didn't answer one vector per text");
    }
    for (const vector of answer) {
      dims ??= Array.isArray(vector) ? vector.length : 0;
      if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.length !== dims ||
        !vector.every(Number.isFinite)
      ) {
        throw protocol("the embedding service answered a malformed vector");
      }
    }
    vectors.push(...answer);
    start += batch.length;
  }
  return vectors;
}

/**
 * The part of the Workers AI binding this adapter uses (`env.AI.run`). The caller passes it, so
 * the package stays free of Cloudflare imports (ADR-0002).
 */
export type WorkersAiRun = (
  model: string,
  input: { text: string[] },
  options: { signal?: AbortSignal },
) => Promise<unknown>;

/** BAAI's multilingual bge-m3 on Workers AI: 1,024 dimensions, no key needed. */
export class WorkersAiEmbedder implements Embedder {
  readonly provider = "workers-ai";
  readonly model: string;
  readonly #run: WorkersAiRun;

  constructor(options: { run: WorkersAiRun; model?: string }) {
    this.#run = options.run;
    this.model = options.model ?? "@cf/baai/bge-m3";
  }

  embed(texts: readonly string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    return inBatches(texts, 64, async (batch) => {
      let answer: unknown;
      try {
        answer = await this.#run(
          this.model,
          { text: batch },
          options.signal ? { signal: options.signal } : {},
        );
      } catch (error) {
        // A Workers AI error message can quote the input, so only the error's name is kept.
        const name = error instanceof Error ? error.name : "unknown";
        throw new LlmError(`Workers AI failed: ${name}`, "server_error", true);
      }
      const data = (answer as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) throw protocol("Workers AI answered without vectors");
      return data as number[][];
    });
  }
}

export interface OpenAIEmbedderConfig {
  apiKey: string;
  /** AI Gateway passthrough, as for `OpenAIResponsesProvider`. Defaults to the OpenAI API. */
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  model?: string;
}

/** OpenAI's embeddings, `text-embedding-3-small` unless told otherwise: 1,536 dimensions. */
export class OpenAIEmbedder implements Embedder {
  readonly provider = "openai";
  readonly model: string;
  readonly #client: OpenAI;

  constructor(config: OpenAIEmbedderConfig) {
    this.model = config.model ?? "text-embedding-3-small";
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.headers ? { defaultHeaders: config.headers } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      maxRetries: 1,
    });
  }

  embed(texts: readonly string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    return inBatches(texts, 256, async (batch) => {
      let data: unknown;
      try {
        const response = await this.#client.embeddings.create(
          { model: this.model, input: batch, encoding_format: "float" },
          options.signal ? { signal: options.signal } : {},
        );
        data = (response as { data?: unknown }).data;
      } catch (error) {
        const failure = toLlmError(error);
        throw failure instanceof LlmError
          ? failure
          : new LlmError(failure instanceof Error ? failure.name : "unknown", "connection", true);
      }
      if (!Array.isArray(data)) throw protocol("OpenAI answered without vectors");
      // Each vector goes to the slot its index names, and every slot is filled exactly once.
      const vectors: number[][] = new Array(batch.length);
      for (const item of data as { index?: unknown; embedding?: unknown }[]) {
        const index = item?.index;
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= batch.length ||
          vectors[index] !== undefined
        ) {
          throw protocol("OpenAI answered vectors out of order");
        }
        vectors[index] = item.embedding as number[];
      }
      if (data.length !== batch.length) throw protocol("OpenAI answered a vector short");
      return vectors;
    });
  }
}
