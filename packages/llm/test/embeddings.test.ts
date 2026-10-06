import { describe, expect, it } from "vitest";
import {
  EMBEDDING_INPUT_CHARS,
  LlmError,
  OpenAIEmbedder,
  WorkersAiEmbedder,
  type WorkersAiRun,
} from "../src/index.ts";
import { fakeFetch, requestAt } from "./fake-fetch.ts";

const vector = (seed: number, dims: number) =>
  Array.from({ length: dims }, (_, i) => seed + i / 1000);

describe("WorkersAiEmbedder", () => {
  /** A fake `AI.run` that answers bge-m3's shape and records each batch. */
  function fakeRun() {
    const batches: string[][] = [];
    const run: WorkersAiRun = async (model, input) => {
      expect(model).toBe("@cf/baai/bge-m3");
      batches.push(input.text);
      return { shape: [input.text.length, 4], data: input.text.map((_, i) => vector(i, 4)) };
    };
    return { run, batches };
  }

  it("embeds texts in batches, in order, and cuts long ones", async () => {
    const { run, batches } = fakeRun();
    const embedder = new WorkersAiEmbedder({ run });
    const texts = Array.from({ length: 130 }, (_, i) => `texto ${i}`);
    texts[3] = "x".repeat(EMBEDDING_INPUT_CHARS + 50);
    const vectors = await embedder.embed(texts);
    expect(batches.map((batch) => batch.length)).toEqual([64, 64, 2]);
    expect(batches[0]?.[3]?.length).toBe(EMBEDDING_INPUT_CHARS);
    expect(vectors).toHaveLength(130);
    expect(vectors[65]).toEqual(vector(1, 4));
    expect(embedder.model).toBe("@cf/baai/bge-m3");
  });

  it("fails on an answer that isn't one vector per text", async () => {
    const embedder = new WorkersAiEmbedder({ run: async () => ({ shape: [1, 4], data: [[0.1]] }) });
    await expect(embedder.embed(["um", "dois"])).rejects.toBeInstanceOf(LlmError);
  });

  it("reports a Workers AI failure by its name only", async () => {
    const embedder = new WorkersAiEmbedder({
      run: async () => {
        throw Object.assign(new Error("input: segredo do usuário"), {
          name: "InferenceUpstreamError",
        });
      },
    });
    const failure = await embedder.embed(["oi"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmError);
    expect(String((failure as Error).message)).not.toContain("segredo");
  });
});

describe("OpenAIEmbedder", () => {
  const answer = (count: number, dims = 3) =>
    new Response(
      JSON.stringify({
        object: "list",
        data: Array.from({ length: count }, (_, i) => ({
          object: "embedding",
          index: i,
          embedding: vector(i, dims),
        })),
        model: "text-embedding-3-small",
        usage: { prompt_tokens: count, total_tokens: count },
      }),
      { headers: { "content-type": "application/json" } },
    );

  it("asks the embeddings endpoint through AI Gateway, in batches, as floats", async () => {
    const { fetch, calls } = fakeFetch(
      () => answer(256),
      () => answer(44),
    );
    const embedder = new OpenAIEmbedder({
      apiKey: "test-key",
      baseURL: "https://gateway.ai.cloudflare.com/v1/acct/kelpie/openai",
      headers: { "cf-aig-authorization": "Bearer gateway" },
      fetch,
    });
    const vectors = await embedder.embed(Array.from({ length: 300 }, (_, i) => `texto ${i}`));
    expect(vectors).toHaveLength(300);
    expect(vectors[256]).toEqual(vector(0, 3));
    const first = requestAt(calls, 0);
    expect(first.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/kelpie/openai/embeddings");
    expect(first.headers.get("cf-aig-authorization")).toBe("Bearer gateway");
    expect(first.body).toMatchObject({ model: "text-embedding-3-small", encoding_format: "float" });
    expect((first.body.input as string[]).length).toBe(256);
    expect(embedder.model).toBe("text-embedding-3-small");
  });

  it("keeps the order the API answers in by index", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [2, 2] },
              { index: 0, embedding: [1, 1] },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const embedder = new OpenAIEmbedder({ apiKey: "test-key", fetch });
    expect(await embedder.embed(["a", "b"])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("maps a refused key to an auth error", async () => {
    const { fetch } = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    );
    const embedder = new OpenAIEmbedder({ apiKey: "test-key", fetch });
    await expect(embedder.embed(["oi"])).rejects.toMatchObject({ code: "auth" });
  });
});
