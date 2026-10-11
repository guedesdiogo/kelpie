import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/jsonc.ts";
import { WORKERS } from "../src/workers.ts";

const apps = join(import.meta.dirname, "..", "..", "..", "apps");

interface Config {
  name: string;
  vars?: Record<string, unknown>;
  services?: Array<{ service: string }>;
  durable_objects?: { bindings?: Array<{ script_name?: string }> };
}

const configs = new Map(
  readdirSync(apps).map((app) => [
    app,
    parseJsonc(readFileSync(join(apps, app, "wrangler.jsonc"), "utf8")) as Config,
  ]),
);

describe("WORKERS", () => {
  it("lists every Worker under apps/ once, by its script name", () => {
    expect(WORKERS.map((worker) => worker.app).sort()).toEqual([...configs.keys()].sort());
    for (const worker of WORKERS) expect(configs.get(worker.app)?.name).toBe(worker.script);
  });

  it("carries only vars its config declares", () => {
    for (const worker of WORKERS) {
      for (const name of worker.instanceVars) {
        expect(configs.get(worker.app)?.vars, `${worker.app} ${name}`).toHaveProperty(name);
      }
    }
  });

  it("deploys each Worker after the Workers its bindings name", () => {
    WORKERS.forEach((worker, index) => {
      const config = configs.get(worker.app) as Config;
      const named = [
        ...(config.services ?? []).map((service) => service.service),
        ...(config.durable_objects?.bindings ?? []).flatMap((binding) =>
          binding.script_name ? [binding.script_name] : [],
        ),
      ];
      const earlier = WORKERS.slice(0, index).map((before) => before.script);
      for (const script of named)
        expect(earlier, `${worker.app} binds ${script}`).toContain(script);
    });
  });
});
