import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { REGISTRY_NAME } from "@kelpie/config";
import type { RoutedRequest } from "@kelpie/llm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { replaceTaskRunnerForTesting } from "../src/agent-host/agent-host.ts";
import { configCommands, proposalProvider, replacePortsForTesting } from "../src/ports.ts";
import { SUBAGENT_TOOLS } from "../src/subagent-limits.ts";
import { taskTools } from "../src/task-tools.ts";
import type { ToolProvider } from "../src/tools.ts";
import { type FakeWorld, fakeWorld, reply, toolCalls } from "./fakes.ts";

// A proposal from end to end (ADR-0060, #302), with the real Registry, AgentHosts and
// conversations: a specialist's task run proposes a higher tier for its subagent, Kelpie tells the
// owner in their conversation with Master, the owner's decision applies it, and the task resumes
// with Kelpie's comment. Master's turns and the specialist's each have their own fake model, so
// the two never take each other's scripts.

const host = (agentId: string) => env.AGENT_HOST.getByName(agentId);
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const registry = () => env.REGISTRY.getByName(REGISTRY_NAME);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
const SALES = "pf-sales";
const SUB = "pf-sales-sub-a1b2c3";
const MASTER = "kelpie:telegram:pf-master";

const until = (check: () => Promise<void> | void) => vi.waitFor(check, { timeout: 10_000 });

/** Master's model and the specialist's, behind one set of ports. */
function worlds(master: FakeWorld, others: FakeWorld) {
  const commands = configCommands(env);
  const tools: ToolProvider[] = [
    // Made where each turn runs, as production makes it: stubs from the test's own context can't
    // be used inside an object.
    { tools: (agentId, place) => proposalProvider(env, configCommands(env)).tools(agentId, place) },
    taskTools({
      owned: async (id) =>
        (await registry().list())
          .filter((entry) => entry.owner === id)
          .map(({ id: agentId, name }) => ({ id: agentId, name })),
      create: (assignee, task, creator) => host(assignee).createTaskFor(task, creator),
      comment: (assignee, taskId, text, by) =>
        host(assignee).commentTaskAs(taskId, text, by, "chat"),
    }),
  ];
  const isMaster = (request: RoutedRequest) => request.system.includes("# Skill: configure-kelpie");
  replacePortsForTesting({
    ...master.ports,
    get tools() {
      return tools;
    },
    generate: (selection, request, session) =>
      (isMaster(request) ? master : others).ports.generate(selection, request, session),
  });
  return commands;
}

const message = (thread: string, agentId: string, text: string) => ({
  agentId,
  providerMessageId: `${thread}:${crypto.randomUUID()}`,
  userId: "u-owner",
  role: "owner" as const,
  chatType: "direct" as const,
  text,
  destination: { channel: "telegram" as const, threadId: thread },
  sentAt: Date.now(),
  timeZone: null,
});

const userTexts = (world: FakeWorld) =>
  world.requests.flatMap((request) =>
    request.messages.filter((one) => one.role === "user").map((one) => JSON.stringify(one.parts)),
  );

async function proposalEvents() {
  return runInDurableObject(registry(), (_instance, state) =>
    state.storage.sql
      .exec<{ kind: string }>("SELECT kind FROM proposal_events ORDER BY id")
      .toArray()
      .map((row) => row.kind),
  );
}

beforeAll(async () => {
  await registry().add(SALES, "Sales", owner);
  // Its own tier is medium, so its subagent may be raised to it (ADR-0036 §5).
  await host(SALES).configure({ spawn: true, model: { conversation: { tier: "medium" } } }, owner);
  expect(await host(SUB).bindCreator(SALES)).toEqual({ ok: true });
  await registry().addSubagent(SUB, "Quotes", SALES, { ...owner, via: `agent:${SALES}` });
  await host(SUB).configure(
    {
      systemPrompt: "You price quotes.",
      tools: [...SUBAGENT_TOOLS],
      model: { provider: "anthropic", conversation: { tier: "cheap" } },
      maxConcurrentTasks: 1,
    },
    owner,
  );
});
/** The conversations a test started, which `afterEach` lets finish before the next one. */
const started: string[] = [];

/** Waits until none of these conversations runs a turn, so none takes the next test's scripts. */
async function quiet(...names: string[]) {
  await until(async () => {
    for (const name of names) {
      const turns = await agent(name).turns();
      expect(turns.every((turn) => turn.status !== "running")).toBe(true);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

afterEach(async () => {
  await quiet(...started.splice(0));
  replaceTaskRunnerForTesting(undefined);
  replacePortsForTesting(undefined);
});

describe("a proposal from end to end (#302)", () => {
  it("goes from a specialist's run to Master's conversation, applies on the owner's decision, and resumes the task", async () => {
    const master = fakeWorld([
      reply("Hello."),
      reply("Sales proposes a higher tier for its subagent: Kelpie sent you its page."),
    ]);
    const others = fakeWorld([
      toolCalls({
        name: "propose_agent_change",
        input: {
          agentId: SUB,
          changes: { model: { conversation: { tier: "medium" } } },
          reason: "Long quotes need the medium tier.",
        },
      }),
      toolCalls({
        name: "wait_on_task",
        input: { reason: "dependency", question: "Waiting for the owner's decision." },
      }),
      reply("Waiting."),
      toolCalls({ name: "complete_task", input: { result: "Priced on the medium tier." } }),
      reply("Done."),
    ]);
    const commands = worlds(master, others);

    // The owner's conversation with Master, where Kelpie's notice goes.
    await agent(MASTER).ingest(message("pf-master", "kelpie", "Hello there, how are you today?"));
    await agent(MASTER).flush();
    await until(() => expect(master.sent).toEqual(["Hello."]));

    const created = await host(SALES).createTask(
      { title: "Price the Silva quote", body: "", status: "todo", scheduledStartAt: null },
      owner,
    );
    if (!created.ok) throw new Error(created.reason);
    const taskId = created.value.id;
    started.push(MASTER, `${SALES}:task:${taskId}`);

    // The run proposes, then waits on the decision.
    await until(async () =>
      expect(await host(SALES).getTask(taskId)).toMatchObject({
        ok: true,
        value: { status: "waiting", waitingReason: "dependency" },
      }),
    );
    const [proposal] = await registry().proposals("pending");
    expect(proposal).toMatchObject({
      proposer: SALES,
      target: SUB,
      taskId,
      changes: { model: { provider: "anthropic", conversation: { tier: "medium" } } },
      before: { model: { provider: "anthropic", conversation: { tier: "cheap" } } },
    });
    const id = proposal?.id ?? "";

    // Kelpie's notice follows Master's reply, with the page as its one link, which no model saw.
    const link = `https://admin.example/proposals/${id}?lang=en`;
    await until(() =>
      expect(master.sent).toEqual([
        "Hello.",
        "Sales proposes a higher tier for its subagent: Kelpie sent you its page.",
        `The agent ${SALES} proposes a change to the agent ${SUB}: model. Review it, then approve or refuse it here: ${link}\nIt expires in 72 hours.`,
      ]),
    );
    expect(userTexts(master).at(-1)).toContain("Long quotes need the medium tier.");
    expect(JSON.stringify([master.requests, others.requests])).not.toContain("/proposals/");
    expect(JSON.stringify(await agent(MASTER).history())).not.toContain("/proposals/");
    // Nothing applied yet.
    expect((await host(SUB).config()).settings.model.conversation?.tier).toBe("cheap");

    // The owner approves on the page.
    replaceTaskRunnerForTesting(undefined);
    expect(
      await commands.decideProposal(
        { userId: "u-owner", role: "owner", via: "admin-api" },
        { id, decision: "approve" },
      ),
    ).toMatchObject({ ok: true, value: { status: "applied", decidedBy: "u-owner" } });
    expect((await host(SUB).config()).settings.model).toEqual({
      provider: "anthropic",
      conversation: { tier: "medium" },
    });
    const audit = await runInDurableObject(host(SUB), (_instance, state) =>
      state.storage.sql.exec<{ via: string }>("SELECT via FROM audit_log ORDER BY id").toArray(),
    );
    expect(audit.at(-1)?.via).toBe(`proposal:${id}`);

    // Kelpie's comment resumes the task, whose next run finishes it.
    await runDurableObjectAlarm(registry());
    await until(async () =>
      expect(await host(SALES).getTask(taskId)).toMatchObject({
        ok: true,
        value: { status: "done", result: "Priced on the medium tier." },
      }),
    );
    const detail = await host(SALES).getTask(taskId);
    expect(detail.ok && detail.value.comments.map((one) => one.author.kind)).toEqual([
      "agent",
      "kelpie",
    ]);
    expect(userTexts(others).join("\n")).toContain(
      `Kelpie's notes on it, oldest first:\\n- The owner approved your proposal ${id}`,
    );
    expect(await proposalEvents()).toEqual(["proposed", "claimed", "applied", "told"]);
  });

  it("expires a second proposal through the alarm, and its proposer hears it", async () => {
    const master = fakeWorld([reply("Hi."), reply("Sales proposes a new remit for its subagent.")]);
    const others = fakeWorld([reply("Hello."), reply("Understood: it expired.")]);
    const commands = worlds(master, others);
    // Every bubble goes out through the one set of ports: Master's world records them all.
    const sent = (text: string) => until(() => expect(master.sent).toContain(text));
    started.push("kelpie:telegram:pf-master-2", `${SALES}:telegram:pf-sales`);
    // A conversation with Master, the latest, and the specialist's own with the owner, where the
    // outcome goes without a task.
    await agent("kelpie:telegram:pf-master-2").ingest(
      message("pf-master-2", "kelpie", "Hello there, how are you today?"),
    );
    await agent("kelpie:telegram:pf-master-2").flush();
    await sent("Hi.");
    const own = agent(`${SALES}:telegram:pf-sales`);
    await own.ingest(message("pf-sales", SALES, "Hello there, how are you today?"));
    await own.flush();
    await sent("Hello.");

    const made = await commands.proposeAgentChange(
      { userId: "u-owner", role: "owner", via: `agent:${SALES}` },
      { agentId: SUB, changes: { remit: "Prices quotes." }, reason: "Clearer remit." },
    );
    expect(made).toMatchObject({ ok: true, value: { noticed: true } });
    const id = made.ok ? made.value.proposal.id : "";
    await sent("Sales proposes a new remit for its subagent.");
    await until(() =>
      expect(master.sent.at(-1)).toMatch(
        new RegExp(`^The agent ${SALES} proposes a change to the agent ${SUB}: remit\\. `),
      ),
    );

    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE proposals SET expires_at = ? WHERE id = ?",
        Date.now() - 1,
        id,
      );
    });
    await runDurableObjectAlarm(registry());

    expect(await registry().proposal(id)).toMatchObject({ status: "expired", decidedBy: null });
    await sent("Understood: it expired.");
    expect(userTexts(others).at(-1)).toContain(`Your proposal ${id} to change remit`);
    expect((await host(SUB).config()).settings.remit).toBe("");
    // A repeat of the owner's decision changes nothing.
    expect(
      await commands.decideProposal(
        { userId: "u-owner", role: "owner", via: "admin-api" },
        { id, decision: "approve" },
      ),
    ).toEqual({ ok: false, reason: "not_pending" });
  });

  it("drops a notice whose proposal expired before Master's reply", async () => {
    const master = fakeWorld([reply("Hi."), reply("Noted.")]);
    worlds(master, fakeWorld([]));
    const conversation = agent("kelpie:telegram:pf-expired");
    started.push("kelpie:telegram:pf-expired");
    await conversation.ingest(message("pf-expired", "kelpie", "Hello there, how are you today?"));
    await conversation.flush();
    await until(() => expect(master.sent).toEqual(["Hi."]));

    expect(
      await conversation.proposalNotice("kelpie", {
        id: "1a2b3c4d-1111-4222-8333-444455556666",
        proposer: SALES,
        target: SUB,
        actingUserId: "u-owner",
        reason: "Too late.",
        expiresAt: Date.now() - 1,
        fields: ["remit"],
      }),
    ).toBe(true);

    await until(() => expect(master.sent).toEqual(["Hi.", "Noted."]));
    // Another agent's conversation, or a task's, takes no notice of Master's.
    expect(
      await conversation.proposalNotice(SALES, {
        id: "1a2b3c4d-1111-4222-8333-444455556666",
        proposer: SALES,
        target: SUB,
        actingUserId: "u-owner",
        reason: "x",
        expiresAt: Date.now() + 60_000,
        fields: ["remit"],
      }),
    ).toBe(false);
  });
});
