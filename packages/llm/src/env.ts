// The SDKs read some options from `process.env`, which holds a Worker's vars and secrets under
// `nodejs_compat` (issues #270 and #276). The adapters pass those options explicitly, except one.

type CustomHeadersVariable = "ANTHROPIC_CUSTOM_HEADERS" | "OPENAI_CUSTOM_HEADERS";

/**
 * Throws while the SDK's custom-headers variable is set. The SDK applies those headers after its
 * own auth headers, so they could replace the key, and no option turns the read off. It is read as
 * the SDK reads it: trimmed, with a blank value counting as unset. The value is never quoted.
 */
export function refuseEnvironmentHeaders(name: CustomHeadersVariable): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.[name]?.trim()) {
    throw new Error(`${name} is set, and Kelpie takes no request headers from the environment`);
  }
}
