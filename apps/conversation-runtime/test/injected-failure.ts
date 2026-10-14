/**
 * The message of failures tests inject into a Durable Object. workerd reports a rejected RPC method
 * as unhandled even when its caller handles it, so `vitest.config.ts` ignores errors with it. A file
 * of its own: the config loads in Node, which can't load the fakes' imports.
 */
export const INJECTED_FAILURE = "injected test failure";
