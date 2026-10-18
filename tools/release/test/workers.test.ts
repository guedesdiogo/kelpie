import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/jsonc.ts";
import { WORKERS } from "../src/workers.ts";

const apps = join(import.meta.dirname, "..", "..", "..", "apps");

interface Config {
  name: string;
  vars?: Record<string, unknown>;
  services?: Array<{ binding: string; service: string; entrypoint?: string }>;
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

  // A conversation's session reaches the claude-code route, on the owner's subscription, so only
  // conversation-runtime may bind the entrypoint that takes one (#431). context-store reads outside
  // content and binds LlmGateway, which never does.
  it("binds llm-gateway's LlmChat from conversation-runtime alone", () => {
    const binders = WORKERS.filter((worker) =>
      (configs.get(worker.app)?.services ?? []).some(
        (service) => service.service === "kelpie-llm-gateway" && service.entrypoint === "LlmChat",
      ),
    ).map((worker) => worker.app);
    expect(binders).toEqual(["conversation-runtime"]);
  });

  // A binding to a missing entrypoint deploys, and fails only when called: ingress's DEPLOY_PROBE,
  // for one, is called only by the deploy's deep probe (#234). Tests stub these Workers, so the
  // names are checked here against the real ones.
  it("binds only entrypoints the bound Worker exports", () => {
    for (const worker of WORKERS) {
      for (const { binding, service, entrypoint } of configs.get(worker.app)?.services ?? []) {
        if (!entrypoint) continue;
        const target = WORKERS.find((candidate) => candidate.script === service);
        const index = readFileSync(join(apps, target?.app ?? "", "src", "index.ts"), "utf8");
        const exported = new RegExp(
          `export (class ${entrypoint}\\b|\\{[^}]*\\b${entrypoint}\\b[^}]*\\})`,
        );
        expect(index, `${worker.app}'s ${binding} names ${service}#${entrypoint}`).toMatch(
          exported,
        );
      }
    }
  });
});
