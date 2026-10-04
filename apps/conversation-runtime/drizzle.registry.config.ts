import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/registry/schema.ts",
  out: "./src/registry/migrations",
});
