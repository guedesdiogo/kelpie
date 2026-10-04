import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A key for tests only: 32 bytes of 0x2a, base64.
      miniflare: { bindings: { SECRETS_KEY: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=" } },
    }),
  ],
});
