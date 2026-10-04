import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/agent-host/schema.ts",
  out: "./src/agent-host/migrations",
});
