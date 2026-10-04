import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/secrets/schema.ts",
  out: "./src/secrets/migrations",
});
