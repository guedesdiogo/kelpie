// Bun's server, as the runner starts it. Node's APIs and globals come with the Agent SDK's types,
// which reference `@types/node` (through the Anthropic SDK's `undici-types`), as packages/llm's do.

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    /** False: an error answers a bare 500, never Bun's page with the source and its path. */
    development: boolean;
    /** The server lets `fetch` set a request's own idle timeout, in seconds; 0 lifts it. */
    fetch: (
      request: Request,
      server: { timeout(request: Request, seconds: number): void },
    ) => Response | Promise<Response>;
  }): unknown;
};
