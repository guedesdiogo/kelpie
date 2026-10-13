import { SETUP_AGENT_ID } from "@kelpie/config";
import type { RouteModel } from "@kelpie/llm/router";
import { describe, expect, it } from "vitest";
import { identitySection } from "../src/agent-host/identity.ts";

describe("identitySection", () => {
  const haiku: RouteModel = {
    provider: "anthropic",
    model: "haiku",
    standsFor: "the newest Claude Haiku",
  };
  const luna: RouteModel = { provider: "openai", model: "gpt-6-luna" };

  it("names the agent and its role, and says who it is isn't the model", () => {
    const text = identitySection({ id: "bia", name: "Bia", tier: "cheap", route: [haiku] });

    expect(
      text.startsWith("# Who you are\n\nYou are Bia, one of the owner's agents on Kelpie"),
    ).toBe(true);
    expect(text).toContain("When someone asks who you are, answer as Bia:");
    expect(text).toContain("never present yourself as that model or as its maker's assistant");
    expect(text).toContain(
      "may have come from another model and may name it: they were still you, Bia.",
    );
  });

  it("says what the tier runs on, an alias spelled out, with the fallbacks in order", () => {
    const route = (models: RouteModel[]) =>
      identitySection({ id: "bia", name: "Bia", tier: "cheap", route: models });

    expect(route([haiku])).toContain(
      "You run on Kelpie's cheap tier: anthropic haiku (the newest Claude Haiku). Your configuration can change the model.",
    );
    expect(route([haiku, luna])).toContain(
      "cheap tier: anthropic haiku (the newest Claude Haiku), or openai gpt-6-luna when it is unavailable.",
    );
    expect(route([haiku, luna, { provider: "openai", model: "gpt-6-sol" }])).toContain(
      "or openai gpt-6-luna, then openai gpt-6-sol when it is unavailable.",
    );
    expect(route([])).toContain(
      "You run on Kelpie's cheap tier, which has no model configured yet.",
    );
  });

  it("leaves the model out while the route was never known", () => {
    const text = identitySection({ id: "bia", name: "Bia", tier: "cheap", route: null });
    expect(text).not.toContain("You run on");
    expect(text).toContain("You are Bia, one of the owner's agents on Kelpie");
  });

  it("gives the setup agent its own role", () => {
    const text = identitySection({ id: SETUP_AGENT_ID, name: "Setup", tier: "cheap", route: [] });
    expect(text).toContain("You are Setup, Kelpie's setup agent, which configures Kelpie.");
  });
});
