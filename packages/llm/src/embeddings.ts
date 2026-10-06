import OpenAI from "openai";
import { errorFromStatus, LlmError } from "./errors.ts";

/** The embedding services an instance can choose between (issue #110). */
export const EMBEDDING_PROVIDERS = ["workers-ai", "openai"] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * A text is cut to this many characters before it is embedded: both models take a few thousand
 * tokens at most, and a note's start says what it is about.
 */
export const EMBEDDING_INPUT_CHARS = 8_000;

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

const cut = (text: string) => text.slice(0, EMBEDDING_INPUT_CHARS);

async function inBatches(
  texts: readonly string[],
  size: number,
  embedBatch: (batch: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += size) {
    const batch = texts.slice(start, start + size).map(cut);
    const answer = await embedBatch(batch);
    if (
      answer.length !== batch.length ||
      !answer.every((v) => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite))
    ) {
      throw new LlmError(
        "the embedding service didn't answer one vector per text",
        "protocol",
        false,
      );
    }
    vectors.push(...answer);
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
      return Array.isArray(data) ? (data as number[][]) : [];
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
      try {
        const response = await this.#client.embeddings.create(
          { model: this.model, input: batch, encoding_format: "float" },
          options.signal ? { signal: options.signal } : {},
        );
        return [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
      } catch (error) {
        if (error instanceof OpenAI.APIUserAbortError) {
          throw new LlmError("the embedding request was aborted", "aborted", false);
        }
        if (error instanceof OpenAI.APIError) {
          throw errorFromStatus(error.status, error.message);
        }
        throw new LlmError(error instanceof Error ? error.message : "unknown", "connection", true);
      }
    });
  }
}
