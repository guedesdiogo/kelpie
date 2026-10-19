import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_COMMAND } from "../src/hook.ts";
import { HOOK_EVENTS } from "../src/spool.ts";

// docs/runner.md's snippets that install and remove the session-event hook, run as written on a
// made-up `~/.claude/settings.json`, with bash and jq. And the one checkout the docs, the unit and
// the hook's command all name.

const DOCS = readFileSync(
  fileURLToPath(new URL("../../../docs/runner.md", import.meta.url)),
  "utf8",
);
const UNIT = readFileSync(
  fileURLToPath(new URL("../kelpie-runner.service", import.meta.url)),
  "utf8",
);
const BLOCKS = [...DOCS.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] as string);
const INSTALL = BLOCKS.find((block) => block.includes("--argjson hook")) as string;
const REMOVE = BLOCKS.find((block) => block.includes("def mine")) as string;

/** The owner's settings, with other tools' hooks, and a group without hooks of its own. */
const SETTINGS = {
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook" }] }],
    Stop: [{ hooks: [{ type: "command", command: "ai-memory hook stop" }] }],
    PostToolUse: [{ matcher: "Write" }],
    SessionStart: [{ hooks: [{ type: "command", command: "herdr hook" }] }],
  },
};

let home: string;
let file: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kelpie-runner-docs-"));
  mkdirSync(join(home, ".claude"));
  file = join(home, ".claude", "settings.json");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const run = (script: string) =>
  spawnSync("bash", ["-c", script], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 15_000,
  });
const settings = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const write = (value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

describe("docs/runner.md's hook snippets", () => {
  it("are both there", () => {
    expect(INSTALL).toContain(JSON.stringify(HOOK_COMMAND));
    expect(REMOVE).toContain("session-events");
  });

  it("install one group per event beside the others' hooks, and the same on a second run", () => {
    write(SETTINGS);
    expect(run(INSTALL).status).toBe(0);
    const once = readFileSync(file, "utf8");
    const hooks = settings().hooks as Record<string, { hooks?: { command: string }[] }[]>;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]?.at(-1)).toEqual({
        hooks: [{ type: "command", command: HOOK_COMMAND, async: true, timeout: 2 }],
      });
    }
    expect(hooks.PreToolUse).toEqual(SETTINGS.hooks.PreToolUse);
    expect(hooks.Stop?.[0]).toEqual(SETTINGS.hooks.Stop[0]);
    expect(hooks.PostToolUse?.[0]).toEqual({ matcher: "Write" });
    expect(run(INSTALL).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(once);
    expect(existsSync(`${file}.new`)).toBe(false);
  });

  it("replace a hook installed from the checkout's old folder, ~/kelpie", () => {
    const old = HOOK_COMMAND.replace("$HOME/Repos/kelpie/", "$HOME/kelpie/");
    expect(old).toContain('cd "$HOME/kelpie/tools/runner"');
    const hook = { type: "command", async: true, timeout: 2 };
    write({ hooks: { Stop: [{ hooks: [{ ...hook, command: old }] }] } });
    expect(run(INSTALL).status).toBe(0);
    const hooks = settings().hooks as Record<string, unknown>;
    expect(hooks.Stop).toEqual([{ hooks: [{ ...hook, command: HOOK_COMMAND }] }]);
  });

  it("remove it again, leaving the settings as they were", () => {
    write(SETTINGS);
    run(INSTALL);
    expect(run(REMOVE).status).toBe(0);
    expect(settings()).toEqual(SETTINGS);
    expect(run(REMOVE).status).toBe(0);
    expect(settings()).toEqual(SETTINGS);
  });

  it("install into settings without hooks, and remove back to them", () => {
    write({ theme: "dark" });
    run(INSTALL);
    expect(Object.keys(settings().hooks as object).sort()).toEqual([...HOOK_EVENTS].sort());
    run(REMOVE);
    expect(settings()).toEqual({ theme: "dark" });
    // An empty `hooks` the owner wrote stays.
    write({ hooks: {} });
    run(REMOVE);
    expect(settings()).toEqual({ hooks: {} });
  });

  it("leave settings that aren't JSON untouched, with nothing beside them", () => {
    writeFileSync(file, '{"hooks": ');
    for (const snippet of [INSTALL, REMOVE]) {
      const result = run(snippet);
      expect(result.stdout).toContain("settings.json unchanged");
      expect(readFileSync(file, "utf8")).toBe('{"hooks": ');
      expect(existsSync(`${file}.new`)).toBe(false);
    }
  });

  it("keep the file's mode, and an older backup", () => {
    write(SETTINGS);
    writeFileSync(`${file}.bak`, "the owner's older backup");
    run(`chmod 600 "${file}"`);
    run(INSTALL);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("the owner's older backup");
  });

  it("follow a symlinked settings.json, and leave the link in place", () => {
    const real = join(home, "dotfiles", "claude-settings.json");
    mkdirSync(join(home, "dotfiles"));
    writeFileSync(real, `${JSON.stringify(SETTINGS, null, 2)}\n`);
    run(`ln -s "${real}" "${file}"`);
    expect(run(INSTALL).status).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readlinkSync(file)).toBe(real);
    expect(Object.keys(settings().hooks as object)).toContain("Notification");
    expect(existsSync(`${real}.bak`)).toBe(true);
    expect(existsSync(`${file}.bak`)).toBe(false);
    expect(run(REMOVE).status).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(settings()).toEqual(SETTINGS);
  });

  it.each([
    ["a folder that isn't there", "gone/claude-settings.json"],
    ["a file that isn't there", "dotfiles/claude-settings.json"],
  ])("stop, writing and removing nothing, when settings.json links to %s", (_, target) => {
    mkdirSync(join(home, "dotfiles"));
    run(`ln -s "${join(home, target)}" "${file}"`);
    const spool = join(home, ".local", "state", "kelpie-runner", "session-events");
    mkdirSync(spool, { recursive: true });
    for (const snippet of [INSTALL, REMOVE]) {
      const result = run(snippet);
      expect(result.stdout).toContain("settings.json unchanged");
      expect(readlinkSync(file)).toBe(join(home, target));
    }
    expect(existsSync(spool)).toBe(true);
    expect(run(`find "${home}" -name '*.bak' -o -name '*.new'`).stdout).toBe("");
  });

  it("back the settings up first, when no backup is there", () => {
    write(SETTINGS);
    const original = readFileSync(file, "utf8");
    run(INSTALL);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(original);
  });
});

describe("the runner's checkout", () => {
  it("is ~/Repos/kelpie, for the docs, the unit and the hook's command alike", () => {
    expect(UNIT).toMatch(/^WorkingDirectory=%h\/Repos\/kelpie$/m);
    expect(HOOK_COMMAND).toMatch(/^cd "\$HOME\/Repos\/kelpie\/tools\/runner" && /);
    expect(DOCS).toContain("git clone https://github.com/guedesdiogo/kelpie.git ~/Repos/kelpie\n");
    expect(DOCS).toContain("cp ~/Repos/kelpie/tools/runner/kelpie-runner.service ");
    expect(`${DOCS}\n${UNIT}\n${HOOK_COMMAND}`).not.toMatch(/(~|\$HOME|%h)\/kelpie(?![\w-])/);
  });
});
