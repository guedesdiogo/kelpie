import type { ChannelIdentity, IdentityStatus } from "@kelpie/access";
import { describe, expect, it } from "vitest";
import { type Actor, type ConfigPorts, createConfigCommands } from "../src/commands.ts";
import { type AgentSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

const owner: Actor = { userId: "u-owner", role: "owner", via: "admin-api" };
const member: Actor = { userId: "u-member", role: "member", via: "admin-api" };

function fakePorts() {
  const agents = new Map<
    string,
    { name: string; settings: AgentSettings; promptVersion: number }
  >();
  const identities = new Map<string, { identity: ChannelIdentity; status: IdentityStatus }>();
  const key = (identity: ChannelIdentity) => `${identity.channel}:${identity.channelUserId}`;
  const calls: string[] = [];
  const ports: ConfigPorts = {
    registry: {
      async add(id, name) {
        calls.push(`add ${id}`);
        if (agents.has(id)) return { created: false };
        agents.set(id, { name, settings: DEFAULT_SETTINGS, promptVersion: 0 });
        return { created: true };
      },
      async rename(id, name) {
        const agent = agents.get(id);
        if (agent) agent.name = name;
        return { found: Boolean(agent) };
      },
      async get(id) {
        const agent = agents.get(id);
        return agent ? { id, name: agent.name } : null;
      },
      async list() {
        return [...agents].map(([id, { name }]) => ({ id, name }));
      },
    },
    agents: {
      async configure(id, changes) {
        const agent = agents.get(id);
        if (!agent) throw new Error("unknown agent");
        if (changes.systemPrompt && changes.systemPrompt !== agent.settings.systemPrompt) {
          agent.promptVersion += 1;
        }
        agent.settings = { ...agent.settings, ...changes };
        return {
          ok: true,
          value: { settings: agent.settings, promptVersion: agent.promptVersion },
        };
      },
      async config(id) {
        const agent = agents.get(id);
        if (!agent) throw new Error("unknown agent");
        return { settings: agent.settings, promptVersion: agent.promptVersion };
      },
    },
    directory: {
      async addIdentity(_userId, identity) {
        const found = identities.get(key(identity));
        if (found) return { ok: true, status: found.status };
        identities.set(key(identity), { identity, status: "pending" });
        return { ok: true, status: "pending" };
      },
      async enableIdentity(identity) {
        const found = identities.get(key(identity));
        if (!found) return { ok: false, reason: "unknown_identity" };
        found.status = "enabled";
        return { ok: true, status: "enabled" };
      },
      async disableIdentity(identity) {
        const found = identities.get(key(identity));
        if (!found) return { ok: false, reason: "unknown_identity" };
        found.status = "disabled";
        return { ok: true, status: "disabled" };
      },
      async listIdentities() {
        return [...identities.values()].map(({ identity, status }) => ({ ...identity, status }));
      },
    },
  };
  return { ports, calls };
}

describe("configuration commands", () => {
  it("lets the owner create, rename and configure an agent", async () => {
    const commands = createConfigCommands(fakePorts().ports);

    expect(await commands.createAgent(owner, { id: "sales", name: "Sales" })).toEqual({
      ok: true,
      value: { id: "sales", name: "Sales", created: true },
    });
    expect(await commands.renameAgent(owner, { id: "sales", name: "Vendas" })).toEqual({
      ok: true,
      value: { id: "sales", name: "Vendas" },
    });
    expect(
      await commands.configureAgent(owner, {
        id: "sales",
        settings: { systemPrompt: "You sell.", conversational: false },
      }),
    ).toMatchObject({
      ok: true,
      value: { settings: { systemPrompt: "You sell.", conversational: false }, promptVersion: 1 },
    });
    expect(await commands.getAgent(owner, { id: "sales" })).toMatchObject({
      ok: true,
      value: { id: "sales", name: "Vendas", promptVersion: 1 },
    });
    expect(await commands.listAgents(owner)).toEqual({
      ok: true,
      value: [{ id: "sales", name: "Vendas" }],
    });
  });

  it("creates an agent idempotently", async () => {
    const commands = createConfigCommands(fakePorts().ports);
    await commands.createAgent(owner, { id: "sales", name: "Sales" });

    expect(await commands.createAgent(owner, { id: "sales", name: "Sales" })).toMatchObject({
      ok: true,
      value: { created: false },
    });
  });

  it("refuses everyone but the owner, before touching anything", async () => {
    const { ports, calls } = fakePorts();
    const commands = createConfigCommands(ports);

    expect(await commands.createAgent(member, { id: "sales", name: "Sales" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await commands.listIdentities(member)).toEqual({ ok: false, reason: "forbidden" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["an id that isn't a slug", { id: "Sales Team", name: "Sales" }],
    ["an id that starts with a digit", { id: "1sales", name: "Sales" }],
    ["an empty name", { id: "sales", name: " " }],
    ["no input", undefined],
  ])("refuses %s", async (_label, input) => {
    const commands = createConfigCommands(fakePorts().ports);
    expect(await commands.createAgent(owner, input)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("refuses invalid settings and unknown agents", async () => {
    const commands = createConfigCommands(fakePorts().ports);
    await commands.createAgent(owner, { id: "sales", name: "Sales" });

    expect(
      await commands.configureAgent(owner, { id: "sales", settings: { tier: "gpt-9" } }),
    ).toEqual({ ok: false, reason: "invalid_input" });
    expect(
      await commands.configureAgent(owner, { id: "ghost", settings: { tier: "frontier" } }),
    ).toEqual({ ok: false, reason: "unknown_agent" });
    expect(await commands.getAgent(owner, { id: "ghost" })).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
  });

  it("manages the owner's identities and masks their values", async () => {
    const commands = createConfigCommands(fakePorts().ports);
    const phone = { channel: "whatsapp", channelUserId: "+5511987654321" };

    expect(await commands.addIdentity(owner, phone)).toEqual({
      ok: true,
      value: { channel: "whatsapp", value: "+5••••••••••21", status: "pending" },
    });
    expect(await commands.enableIdentity(owner, phone)).toMatchObject({
      ok: true,
      value: { status: "enabled" },
    });
    const listed = await commands.listIdentities(owner);
    expect(listed).toEqual({
      ok: true,
      value: [{ channel: "whatsapp", value: "+5••••••••••21", status: "enabled" }],
    });
    expect(JSON.stringify(listed)).not.toContain(phone.channelUserId);
  });

  it("passes the Directory's refusals through", async () => {
    const commands = createConfigCommands(fakePorts().ports);

    expect(
      await commands.enableIdentity(owner, { channel: "telegram", channelUserId: "1001" }),
    ).toEqual({ ok: false, reason: "unknown_identity" });
    expect(await commands.addIdentity(owner, { channel: "fax", channelUserId: "1" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });
});
