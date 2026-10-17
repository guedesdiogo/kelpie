// Bun's server, as the runner starts it. Node's APIs and globals come with the Agent SDK's types,
// which reference `@types/node` (through the Anthropic SDK's `undici-types`), as packages/llm's do.

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    /** False: an error answers a bare 500, never Bun's page with the source and its path. */
    development: boolean;
    /** Seconds a connection may stay silent before Bun closes it; 0 never closes it. */
    idleTimeout: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): unknown;
};
