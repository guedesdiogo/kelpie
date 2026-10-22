import type { Locale, ModelKey, ModelKeySource } from "@kelpie/channels";
import type { Actor, CommandResult, InstanceModels } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import {
  CONFIGURE_KELPIE_SKILL,
  type ConfigurationCommands,
  configurationTools,
  MASTER_TOOLS,
} from "../src/configuration.ts";
import { changes } from "../src/outside-content.ts";
import type { ConfirmationRequest, HostLink, Tool, ToolContext } from "../src/tools.ts";

// Master's model key tools (ADR-0068, #496): connect_model_key has Kelpie send a one-time form's
// link, where the owner pastes the key, so the key never passes through the model or the chat;
// remove_model_key removes a key set through a form, with the owner's confirmation.

const ADMIN = "https://admin.example.com";
const MASTER = "kelpie";
const owner: Actor = { userId: "u-owner", role: "owner", via: `agent:${MASTER}` };
const KEY = `sk-ant-api03-${"k".repeat(80)}`;
const EXPIRES = Date.UTC(2026, 9, 22, 20);
const NOW = Date.UTC(2026, 9, 22, 19, 45);

/** The commands these tools run, over a model key table; every call is logged. */
function fakeCommands(keys: Record<ModelKey, ModelKeySource>) {
  const calls: string[] = [];
  const forbidden = { ok: false, reason: "forbidden" } as const;
  const unused = async (): Promise<never> => {
    throw new Error("not used here");
  };
  const failures: { connect?: CommandResult<never>; remove?: CommandResult<never> } = {};
  const commands = {
    listAgents: unused,
    getAgent: unused,
    createAgent: unused,
    renameAgent: unused,
    configureAgent: unused,
    configureModels: unused,
    setClaudeCode: unused,
    setMaster: unused,
    setAgentChat: unused,
    deleteAgent: unused,
    connectTelegram: unused,
    connectRunner: unused,
    describeRunner: unused,
    async getModels(actor: Actor): Promise<CommandResult<InstanceModels>> {
      if (actor.role !== "owner") return forbidden;
      return {
        ok: true,
        value: { settings: {}, pinned: "anthropic", providers: ["anthropic"], keys },
      };
    },
    async connectModelKey(actor: Actor, input: unknown) {
      calls.push(`connectModelKey ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      if (failures.connect) return failures.connect;
      const { provider } = input as { provider: ModelKey };
      return { ok: true as const, value: { provider, path: "/forms/key789", expiresAt: EXPIRES } };
    },
    async removeModelKey(actor: Actor, input: unknown) {
      calls.push(`removeModelKey ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      if (failures.remove) return failures.remove;
      const { provider } = input as { provider: ModelKey };
      const removed = keys[provider] === "form";
      keys[provider] = "none";
      return { ok: true as const, value: { provider, removed } };
    },
  } as unknown as ConfigurationCommands;
  return { commands, calls, failures };
}

function contextOf(confirmed: boolean, locale: Locale = "en", actor: Actor = owner) {
  const asked: ConfirmationRequest[] = [];
  const links: HostLink[] = [];
  const context: ToolContext = {
    locale,
    actor,
    agentId: MASTER,
    scopes: "all",
    trigger: "person",
    qualifier: "clef",
    turn: "1",
    source: "webchat:u-owner, 2026-10-22",
    signal: new AbortController().signal,
    async confirm(request) {
      asked.push(request);
      return confirmed;
    },
    sendLink(link) {
      links.push(link);
    },
    announce() {},
  };
  return { context, asked, links };
}

async function toolsWith(
  keys: Record<ModelKey, ModelKeySource> = {
    anthropic: "deploy",
    openai: "form",
    "ai-gateway": "none",
    typesafe: "none",
  },
  adminOrigin = ADMIN,
) {
  const fake = fakeCommands(keys);
  const provider = configurationTools(fake.commands, {
    roleOf: async (id) => (id === MASTER ? "master" : "specialist"),
    adminOrigin,
    now: () => NOW,
  });
  const tools = new Map((await provider.tools(MASTER)).map((tool) => [tool.spec.name, tool]));
  const run = (name: string, input: unknown, context: ToolContext) => {
    const tool = tools.get(name) as Tool;
    return tool.run(input, context);
  };
  return { ...fake, tools, run };
}

describe("connect_model_key", () => {
  it("is Master's, held after outside content like the other form tools, for the four slots", async () => {
    const { tools } = await toolsWith();
    const tool = tools.get("connect_model_key");
    expect(tool?.effect).toBeUndefined();
    expect(changes(tool as Tool)).toBe(true);
    expect(tool?.spec.inputSchema).toEqual({
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["anthropic", "openai", "ai-gateway", "typesafe"],
          description: expect.any(String),
        },
      },
      required: ["provider"],
      additionalProperties: false,
    });
    expect(MASTER_TOOLS.has("connect_model_key")).toBe(true);
  });

  it("sends the form as a link of Kelpie's own, in the owner's language, and waits for it", async () => {
    const { run, calls } = await toolsWith();
    const { context, links, asked } = contextOf(false, "pt-BR");
    const sent = await run("connect_model_key", { provider: "anthropic" }, context);
    expect(sent.isError).toBeUndefined();
    expect(sent.output).toContain("don't ask them to say when they're done");
    expect(sent.output).toContain("the Anthropic API key");
    // The model never sees the link, nor the form's one-time token (ADR-0026).
    expect(sent.output).not.toContain("/forms/");
    expect(sent.output).not.toContain("key789");
    expect(links).toEqual([
      {
        href: `${ADMIN}/forms/key789?lang=pt-BR`,
        text: `O formulário seguro para a chave da API da Anthropic: ${ADMIN}/forms/key789?lang=pt-BR\nFunciona uma vez, nos próximos 15 minutos. Cole a chave lá, nunca no chat.`,
        // Master's own AgentHost keeps the wait, until the form expires (ADR-0060).
        awaits: { agentId: MASTER, step: "model_key_connected", until: EXPIRES },
      },
    ]);
    // Opening a form changes nothing: the owner's submitting it is the yes (ADR-0026).
    expect(asked).toEqual([]);
    expect(calls).toEqual(['connectModelKey {"provider":"anthropic"}']);
  });

  it.each([
    ["en", "The secure form for the AI Gateway token"],
    ["es", "El formulario seguro para el token de AI Gateway"],
  ] as const)("names the key in %s", async (locale, start) => {
    const { run } = await toolsWith();
    const { context, links } = contextOf(false, locale);
    await run("connect_model_key", { provider: "ai-gateway" }, context);
    expect(links[0]?.text.startsWith(start)).toBe(true);
  });

  it("never passes on or repeats a key the model sends", async () => {
    const { run, calls } = await toolsWith();
    const { context, links, asked } = contextOf(false);
    const done = await run("connect_model_key", { provider: "anthropic", key: KEY }, context);
    expect(JSON.stringify([done, links, asked, calls])).not.toContain(KEY);
    expect(calls).toEqual(['connectModelKey {"provider":"anthropic"}']);
  });

  it("refuses a slot that isn't one, a person who isn't the owner, and an admin API without an address", async () => {
    const { run, calls, failures } = await toolsWith();
    const { context, links } = contextOf(false);
    for (const provider of ["claude-code", "OpenAI", undefined]) {
      const refused = await run("connect_model_key", { provider }, context);
      expect(refused, String(provider)).toMatchObject({ isError: true });
      expect(refused.output).toContain("anthropic, openai, ai-gateway or typesafe");
    }
    const member = contextOf(false, "en", { ...owner, role: "member" });
    expect(await run("connect_model_key", { provider: "openai" }, member.context)).toMatchObject({
      isError: true,
      output: "Only the owner can change Kelpie's configuration.",
    });
    failures.connect = { ok: false, reason: "unavailable" };
    expect(await run("connect_model_key", { provider: "openai" }, context)).toMatchObject({
      isError: true,
    });
    expect(links).toEqual([]);
    expect(calls).toEqual(['connectModelKey {"provider":"openai"}']);

    const unset = await toolsWith(undefined, "");
    const answer = await unset.run("connect_model_key", { provider: "openai" }, context);
    expect(answer).toMatchObject({ isError: true });
    expect(answer.output).toContain("ADMIN_ORIGIN");
    expect(unset.calls).toEqual([]);
  });
});

describe("remove_model_key", () => {
  it("asks for its own yes, so outside content doesn't hold it twice", async () => {
    const { tools } = await toolsWith();
    expect(tools.get("remove_model_key")?.effect).toBe("asks");
    expect(changes(tools.get("remove_model_key") as Tool)).toBe(false);
    expect(MASTER_TOOLS.has("remove_model_key")).toBe(true);
  });

  it("shows the owner what goes, and removes the key only once they confirm", async () => {
    const { run, calls } = await toolsWith();
    const waiting = contextOf(false, "pt-BR");
    expect(
      (await run("remove_model_key", { provider: "openai" }, waiting.context)).output,
    ).toContain("Not done yet");
    expect(waiting.asked).toEqual([
      {
        command: "removeModelKey",
        input: { provider: "openai" },
        summary:
          "remover a chave da API da OpenAI guardada pelo formulário: os modelos do Kelpie passam a usar a chave do deploy, se houver, em até um minuto.",
      },
    ]);
    expect(calls).toEqual([]);

    const { context } = contextOf(true);
    const removed = await run("remove_model_key", { provider: "openai" }, context);
    expect(removed.isError).toBeUndefined();
    expect(removed.output).toContain("Removed the OpenAI API key");
    expect(calls).toEqual(['removeModelKey {"provider":"openai"}']);
  });

  it("asks nothing when no key is stored through a form, and says where the one that serves comes from", async () => {
    const { run, calls } = await toolsWith();
    const { context, asked } = contextOf(true);
    const deploy = await run("remove_model_key", { provider: "anthropic" }, context);
    expect(deploy.output).toContain("deploy's Worker secret");
    const none = await run("remove_model_key", { provider: "typesafe" }, context);
    expect(none.output).toContain("nothing to remove");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a slot that isn't one, and says when a Kelpie service didn't answer", async () => {
    const { run, failures } = await toolsWith();
    const { context } = contextOf(true);
    expect(await run("remove_model_key", { provider: "gemini" }, context)).toMatchObject({
      isError: true,
    });
    failures.remove = { ok: false, reason: "unavailable" };
    expect(await run("remove_model_key", { provider: "openai" }, context)).toMatchObject({
      isError: true,
      output: "That didn't work: a Kelpie service didn't answer. Try again in a moment.",
    });
  });
});

describe("get_models", () => {
  it("says where each key comes from, never a key", async () => {
    const { run } = await toolsWith();
    const shown = await run("get_models", {}, contextOf(false).context);
    expect(JSON.parse(shown.output).keys).toEqual({
      anthropic: "deploy",
      openai: "form",
      "ai-gateway": "none",
      typesafe: "none",
    });
  });
});

describe("Master's skill", () => {
  it("sends model keys to their form, and never asks for one in the chat", () => {
    expect(CONFIGURE_KELPIE_SKILL).toContain("connect_model_key");
    expect(CONFIGURE_KELPIE_SKILL).toContain("remove_model_key");
    expect(CONFIGURE_KELPIE_SKILL).not.toContain("and the model keys");
  });
});
