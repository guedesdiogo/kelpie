import type { Actor, AgentRole } from "@kelpie/config";
import type {
  AgentFileChange,
  AgentFilesState,
  MasterAgentFilesContract,
  SaveAgentFilesResult,
} from "@kelpie/context-store/contract";
import { describe, expect, it } from "vitest";
import { AGENT_FILE_TOOLS, agentFileTools, lineDiff } from "../src/agent-file-tools.ts";
import { heldTools, MASTER_TOOLS } from "../src/configuration.ts";
import {
  type ConfirmationRequest,
  confirmationNotice,
  shownSummary,
  type Tool,
  type ToolContext,
} from "../src/tools.ts";

// Master's reads and writes of an agent's own files (ADR-0067 §1, #494): a write waits for the
// owner's confirmation of the change, line by line, with secrets redacted before they see it, and
// names the version it started from, so an edit made since is never overwritten.

const MASTER = "kelpie";
const owner: Actor = { userId: "u-owner", role: "owner", via: `agent:${MASTER}` };
const member: Actor = { userId: "u-guest", role: "member", via: `agent:${MASTER}` };

const state = (fields: Partial<AgentFilesState> = {}): AgentFilesState => ({
  soul: { content: "# Sales\nYou quote bakeries.\nBe brief.", version: "a".repeat(40) },
  rules: null,
  memory: null,
  skills: [
    {
      name: "quotes",
      description: "Writes quotes.",
      content: "# Quotes\nUse the price table.",
      version: "b".repeat(40),
      origin: null,
      edited: false,
    },
  ],
  ...fields,
});

/** MasterAgentFiles over one agent's files, logging each save; answers a test can swap. */
function world(role: { of: AgentRole | null } = { of: "master" }) {
  const saves: { actor: Actor; agentId: string; changes: AgentFileChange[] }[] = [];
  const answers = {
    files: state(),
    save: null as SaveAgentFilesResult | null,
    vaultOff: false,
  };
  const files: MasterAgentFilesContract = {
    async files() {
      return answers.vaultOff
        ? { ok: false, reason: "vault_off" }
        : { ok: true, files: answers.files };
    },
    async save(actor, agentId, changes) {
      saves.push({ actor: actor as Actor, agentId, changes });
      return (
        answers.save ?? {
          ok: true,
          outcomes: [{ status: "saved", version: "c".repeat(40) }],
          commit: "d".repeat(40),
          undo: [],
          files: answers.files,
        }
      );
    },
  };
  const provider = agentFileTools(files, {
    roleOf: async (id) => (id === "ghost" ? null : id === "pup" ? "subagent" : role.of),
  });
  return { provider, saves, answers };
}

function contextOf(
  confirmed: boolean,
  actor: Actor = owner,
  turn: Partial<Pick<ToolContext, "scopes" | "locale" | "trigger">> = {},
) {
  const asked: ConfirmationRequest[] = [];
  const context: ToolContext = {
    locale: turn.locale ?? "en",
    actor,
    agentId: MASTER,
    scopes: turn.scopes ?? "all",
    trigger: turn.trigger ?? "person",
    qualifier: "clef",
    turn: "1",
    source: "webchat:u-owner, 2026-10-22",
    signal: new AbortController().signal,
    async confirm(request) {
      asked.push(request);
      return confirmed;
    },
    sendLink: () => undefined,
    announce: () => undefined,
  };
  return { context, asked };
}

async function toolsOf(provider: ReturnType<typeof world>["provider"]) {
  return new Map((await provider.tools(MASTER)).map((tool) => [tool.spec.name, tool]));
}
const run = (tool: Tool | undefined, input: unknown, context: ToolContext) => {
  if (!tool) throw new Error("no such tool");
  return tool.run(input, context);
};
const SOUL_VERSION = "a".repeat(40);

describe("Master's agent-file tools (ADR-0067 §1, #494)", () => {
  it("go to Master alone, never in a task's run; the read reads and the write asks", async () => {
    const role = { of: "master" as AgentRole | null };
    const { provider } = world(role);
    const tools = await toolsOf(provider);
    expect([...tools.keys()]).toEqual([...AGENT_FILE_TOOLS]);
    expect([...tools.values()].map((tool) => tool.effect)).toEqual(["reads", "asks"]);
    expect(await provider.tools(MASTER, { channel: "task" })).toEqual([]);
    role.of = "specialist";
    expect(await provider.tools("sales")).toEqual([]);
    for (const name of AGENT_FILE_TOOLS) expect(MASTER_TOOLS.has(name), name).toBe(true);
    expect(heldTools("master", [])).toEqual(expect.arrayContaining([...AGENT_FILE_TOOLS]));
  });

  it("refuse anyone but the owner in a direct conversation, an agent no longer Master, and an agent that doesn't exist", async () => {
    const role = { of: "master" as AgentRole | null };
    const { provider, saves } = world(role);
    const tools = await toolsOf(provider);
    const input = { agentId: "sales", file: "soul", content: "x", version: SOUL_VERSION };
    for (const { context } of [contextOf(true, member), contextOf(true, owner, { scopes: [] })]) {
      for (const tool of tools.values()) {
        expect(await tool.run(input, context)).toEqual({
          isError: true,
          output: "Only the owner can change Kelpie's configuration.",
        });
      }
    }
    expect(
      await run(
        tools.get("read_agent_file"),
        { agentId: "ghost", file: "soul" },
        contextOf(true).context,
      ),
    ).toEqual({ isError: true, output: "There is no agent with the id ghost." });
    // A subagent has no files in the vault (ADR-0058 §2), and a note's turn writes none.
    const write = tools.get("write_agent_file");
    expect(await run(write, { ...input, agentId: "pup" }, contextOf(true).context)).toMatchObject({
      isError: true,
      output: expect.stringContaining("is a subagent"),
    });
    const note = contextOf(true, owner, { trigger: "note" });
    expect(await run(write, input, note.context)).toMatchObject({
      isError: true,
      output: expect.stringContaining("in a message of their own"),
    });
    const doubled = {
      agentId: "sales",
      file: "skill",
      name: "my--skill",
      content: "x",
      version: null,
    };
    expect(await run(write, doubled, contextOf(true).context)).toMatchObject({
      isError: true,
      output: expect.stringContaining("one hyphen apart"),
    });
    role.of = "specialist";
    expect(await run(tools.get("write_agent_file"), input, contextOf(true).context)).toMatchObject({
      isError: true,
      output: expect.stringContaining("isn't Master any more"),
    });
    expect(saves).toEqual([]);
  });

  it("read a file fenced as data, with its version, and list the skills", async () => {
    const { provider, answers } = world();
    const read = (await toolsOf(provider)).get("read_agent_file");
    const soul = await run(read, { agentId: "sales", file: "soul" }, contextOf(true).context);
    expect(soul.output).toContain(
      `The soul of the agent sales, version ${SOUL_VERSION}, 37 characters.`,
    );
    expect(soul.output).toMatch(
      /<agent-words-[0-9a-f]{8}>\n# Sales\nYou quote bakeries\.\nBe brief\.\n<\/agent-words-/,
    );
    expect(
      (await run(read, { agentId: "sales", file: "skill" }, contextOf(true).context)).output,
    ).toBe("The agent sales's skills: quotes.");
    expect(
      (
        await run(
          read,
          { agentId: "sales", file: "skill", name: "quotes" },
          contextOf(true).context,
        )
      ).output,
    ).toContain(`The skill quotes of the agent sales, version ${"b".repeat(40)}`);
    expect(
      (await run(read, { agentId: "sales", file: "rules" }, contextOf(true).context)).output,
    ).toBe("The agent sales has no rules file yet: write_agent_file with version null creates it.");
    answers.vaultOff = true;
    expect(await run(read, { agentId: "sales", file: "soul" }, contextOf(true).context)).toEqual({
      isError: true,
      output: "Kelpie's vault isn't set up, so agents have no files there.",
    });
  });

  it("write only after the owner confirms the change line by line, in their language, as the owner through Master", async () => {
    const { provider, saves } = world();
    const write = (await toolsOf(provider)).get("write_agent_file");
    const input = {
      agentId: "sales",
      file: "soul",
      content: "# Sales\nYou quote bakeries and cafés.\nBe brief.",
      version: SOUL_VERSION,
    };
    const waiting = contextOf(false, owner, { locale: "pt-BR" });
    expect((await run(write, input, waiting.context)).output).toContain(
      "waits for their confirmation",
    );
    expect(waiting.asked).toEqual([
      {
        command: "writeAgentFile",
        input: {
          agentId: "sales",
          change: { file: "soul", content: input.content, version: SOUL_VERSION },
        },
        summary:
          "mudar a alma (SOUL.md) do agente sales, linha a linha:\n  # Sales\n- You quote bakeries.\n+ You quote bakeries and cafés.\n  Be brief.",
      },
    ]);
    expect(saves).toEqual([]);
    expect((await run(write, input, contextOf(true).context)).output).toBe(
      `Saved it for the agent sales, version ${"c".repeat(40)}.`,
    );
    expect(saves).toEqual([
      {
        actor: owner,
        agentId: "sales",
        changes: [{ file: "soul", content: input.content, version: SOUL_VERSION }],
      },
    ]);
  });

  it("redact secrets before the owner sees the change, and say so", async () => {
    const { provider, saves } = world();
    const write = (await toolsOf(provider)).get("write_agent_file");
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    const { context, asked } = contextOf(true);
    await run(
      write,
      { agentId: "sales", file: "rules", content: `# Rules\nCall with ${key}.`, version: null },
      context,
    );
    expect(asked[0]?.summary).toMatch(
      /^create the rules \(AGENTS\.md\) of the agent sales:\n\+ # Rules\n\+ Call with \[REDACTED/,
    );
    expect(asked[0]?.summary).toContain("Kelpie redacted 1 secret from the text.");
    expect(JSON.stringify(asked)).not.toContain(key);
    expect(JSON.stringify(saves)).not.toContain(key);
  });

  it("never overwrite an edit made since the read, and say what's off", async () => {
    const { provider, saves, answers } = world();
    const write = (await toolsOf(provider)).get("write_agent_file");
    const stale = { agentId: "sales", file: "soul", content: "# New", version: "e".repeat(40) };
    expect(await run(write, stale, contextOf(true).context)).toEqual({
      isError: true,
      output: `The file changed since you read it, or you didn't read it: read_agent_file shows it as it is now, version ${SOUL_VERSION}.`,
    });
    expect(
      await run(
        write,
        { agentId: "sales", file: "memory", content: "x", version: "f".repeat(40) },
        contextOf(true).context,
      ),
    ).toMatchObject({ isError: true, output: expect.stringContaining("pass version null") });
    answers.save = {
      ok: true,
      outcomes: [{ status: "conflict", current: { content: "# Theirs", version: "9".repeat(40) } }],
      commit: null,
      undo: [],
      files: answers.files,
    };
    expect(
      await run(
        write,
        { agentId: "sales", file: "soul", content: "# Mine", version: SOUL_VERSION },
        contextOf(true).context,
      ),
    ).toMatchObject({
      isError: true,
      output: expect.stringContaining("changed while the owner confirmed"),
    });
    answers.save = {
      ok: true,
      outcomes: [{ status: "refused", reason: "memory_format" }],
      commit: null,
      undo: [],
      files: answers.files,
    };
    expect(
      await run(
        write,
        { agentId: "sales", file: "soul", content: "# Mine", version: SOUL_VERSION },
        contextOf(true).context,
      ),
    ).toEqual({
      isError: true,
      output:
        "The vault refused that file (memory_format): nothing was saved. The memory file holds entries joined by a line of just §, with no blank line around it, no line break at the file's start or end, no blank entry, no § line inside one, no front matter and no carriage return.",
    });
    expect(saves).toHaveLength(2);
  });

  it("remove a skill with content null, and refuse a change too long to show or one that changes nothing", async () => {
    const { provider } = world();
    const write = (await toolsOf(provider)).get("write_agent_file");
    const removing = contextOf(false, owner, { locale: "es" });
    await run(
      write,
      { agentId: "sales", file: "skill", name: "quotes", content: null, version: "b".repeat(40) },
      removing.context,
    );
    expect(removing.asked[0]?.summary).toBe(
      "quitar la skill quotes del agente sales, con todos los archivos de su carpeta",
    );
    expect(
      await run(
        write,
        { agentId: "sales", file: "skill", content: "x", version: null },
        contextOf(true).context,
      ),
    ).toEqual({ isError: true, output: "Name the skill." });
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a much longer soul.`).join(
      "\n",
    );
    expect(
      await run(
        write,
        { agentId: "sales", file: "soul", content: long, version: SOUL_VERSION },
        contextOf(true).context,
      ),
    ).toMatchObject({
      isError: true,
      output: expect.stringContaining("too long to show the owner"),
    });
    expect(
      await run(
        write,
        {
          agentId: "sales",
          file: "soul",
          content: "# Sales\nYou quote bakeries.\nBe brief.",
          version: SOUL_VERSION,
        },
        contextOf(true).context,
      ),
    ).toEqual({ output: "That is already the file's text: nothing to change." });
  });
});

describe("the edges of a file's write (#494)", () => {
  it("says when a file is longer than the read shows, shows an empty new file, and names the folder a skill's removal takes", async () => {
    const { provider, answers } = world();
    const tools = await toolsOf(provider);
    answers.files = state({ soul: { content: "x".repeat(8_100), version: SOUL_VERSION } });
    const long = await run(
      tools.get("read_agent_file"),
      { agentId: "sales", file: "soul" },
      contextOf(true).context,
    );
    expect(long.output).toContain(
      "It is longer than this tool shows, so write_agent_file would drop the rest",
    );
    answers.files = state();
    const empty = contextOf(false);
    await run(
      tools.get("write_agent_file"),
      { agentId: "sales", file: "rules", content: "", version: null },
      empty.context,
    );
    expect(empty.asked[0]?.summary).toBe("create the rules (AGENTS.md) of the agent sales:\n+");
    for (const [locale, said] of [
      ["en", "remove the skill quotes of the agent sales, with every file in its folder"],
      ["pt-BR", "remover a skill quotes do agente sales, com todos os arquivos da pasta dela"],
    ] as const) {
      const removing = contextOf(false, owner, { locale });
      await run(
        tools.get("write_agent_file"),
        { agentId: "sales", file: "skill", name: "quotes", content: null, version: "b".repeat(40) },
        removing.context,
      );
      expect(removing.asked[0]?.summary).toBe(said);
    }
  });
});

describe("the notice of a file's change (#494)", () => {
  it("shows the diff on lines of its own, with each line's hidden characters written out", () => {
    const summary = "change the soul (SOUL.md) of the agent sales, line by line:\n- a\n+ b\u202e";
    expect(confirmationNotice(summary, "K7MPRX", false, "en", "writeAgentFile")).toBe(
      "Confirm: change the soul (SOUL.md) of the agent sales, line by line:\n- a\n+ b\\u{202E}\nTo go ahead, reply with just the code K7MPRX. It expires in 10 minutes.",
    );
    // Any other command's summary stays on one line, every line break written out.
    expect(confirmationNotice("a\nb", "K7MPRX")).toContain("Confirm: a\\u{A}b");
    expect(shownSummary("writeAgentFile", "x\ny")).toBe("x\ny");
    expect(shownSummary("configureAgent", "x\ny")).toBe("x\\u{A}y");
  });
});

describe("lineDiff (#494)", () => {
  it("shows the lines that change with two unchanged lines around them, and … for the rest", () => {
    const lines = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `l${from + i}`);
    const before = lines(1, 12).join("\n");
    const after = [...lines(1, 2), "L3", ...lines(4, 11), "L12"].join("\n");
    expect(lineDiff(before, after)).toBe(
      [
        "  l1",
        "  l2",
        "- l3",
        "+ L3",
        "  l4",
        "  l5",
        "…",
        "  l10",
        "  l11",
        "- l12",
        "+ L12",
      ].join("\n"),
    );
    expect(lineDiff("", "one\ntwo")).toBe("+ one\n+ two");
    expect(lineDiff("one\ntwo", "one\ntwo\nthree")).toBe("  one\n  two\n+ three");
    expect(lineDiff("one\ntwo", "two")).toBe("- one\n  two");
  });

  it("marks the lines it leaves out before the first change and after the last", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    expect(lineDiff(before, after)).toBe(
      ["…", "  l8", "  l9", "- l10", "+ L10", "  l11", "  l12", "…"].join("\n"),
    );
  });

  it("shows a change too big to compare as the whole old and new text", () => {
    const before = Array.from({ length: 600 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 600 }, (_, i) => `b${i}`).join("\n");
    const diff = lineDiff(before, after).split("\n");
    expect(diff).toHaveLength(1_200);
    expect(diff[0]).toBe("- a0");
    expect(diff.at(-1)).toBe("+ b599");
  });
});
