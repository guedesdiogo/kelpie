import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/directory/schema.ts",
  out: "./src/directory/migrations",
});
