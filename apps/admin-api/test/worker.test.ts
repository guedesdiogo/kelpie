import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { depsFor } from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());

describe("admin-api Worker", () => {
  it("reads and sets the instance's model settings through llm-gateway (#289)", async () => {
    const { commands } = depsFor(env);
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

    expect(await commands.getModels(owner)).toEqual({
      ok: true,
      value: { settings: {}, pinned: "anthropic", providers: ["anthropic"] },
    });
    expect(await commands.configureModels(owner, { settings: { provider: "anthropic" } })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("reaches the agent's AgentHost for each task command (#54)", async () => {
    const { commands } = depsFor(env);
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
    const taskId = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";
    const reached = async (result: Promise<{ ok: boolean; value?: unknown }>) => {
      const answer = await result;
      return answer.ok ? answer.value : answer;
    };

    expect(await reached(commands.createTask(owner, { agentId: "sales", title: "Book" }))).toEqual({
      method: "createTask",
      args: [{ title: "Book", body: "", status: "backlog", scheduledStartAt: null }, owner],
    });
    expect(
      await reached(commands.editTask(owner, { agentId: "sales", taskId, body: "Soon." })),
    ).toEqual({ method: "editTask", args: [taskId, { body: "Soon." }, owner] });
    expect(
      await reached(commands.moveTask(owner, { agentId: "sales", taskId, status: "todo" })),
    ).toEqual({ method: "moveTask", args: [taskId, "todo", owner] });
    expect(
      await reached(commands.commentTask(owner, { agentId: "sales", taskId, text: "Hi." })),
    ).toEqual({ method: "commentTask", args: [taskId, "Hi.", owner] });
    expect(await reached(commands.requestStop(owner, { agentId: "sales", taskId }))).toEqual({
      method: "requestStop",
      args: [taskId, owner],
    });
    expect(await reached(commands.listTasks(owner, { agentId: "sales", status: "todo" }))).toEqual([
      { method: "listTasks", args: ["todo"] },
    ]);
    expect(await reached(commands.getTask(owner, { agentId: "sales", taskId }))).toEqual({
      method: "getTask",
      args: [taskId],
    });
  });

  it("refuses every request while the Access application isn't configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await exports.default.fetch("https://admin.example/commands/listAgents", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "a.b.c" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, reason: "unauthenticated" });
    expect(warn).toHaveBeenCalledWith("admin-api: request refused", { reason: "not_configured" });
  });
});
