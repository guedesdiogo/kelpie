// Claude Code's synchronous `PermissionRequest` hook for the Claude app's sessions on the VPS
// (ADR-0069 §1), which the owner installs in `~/.claude/settings.json` (docs/runner.md). Run with
// Bun. It spools the request, waits for the runner's verdict beside the Claude app's prompt, prints
// the decision when one comes, and always exits 0: no decision leaves the prompt as it was. It
// never touches the network.
import { homedir } from "node:os";
import { join } from "node:path";
import { PERMISSION_WAIT_MS, runPermissionHook } from "../src/permission-hook.ts";
import { ownUid } from "../src/secrets.ts";
import { spoolDirOf } from "../src/spool.ts";

const stop = new AbortController();
// Claude Code stops a hook still waiting when its session ends: the request goes with it.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => stop.abort());
// A last bound, past the hook's own deadline and inside Claude Code's timeout.
setTimeout(() => process.exit(0), PERMISSION_WAIT_MS + 15_000);
try {
  const home = homedir();
  const output = await runPermissionHook(process.stdin, {
    dir: spoolDirOf(home),
    // Claude Code's own folder, where its session files are: the one it was told, if any.
    claudeDir: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    uid: ownUid(),
    parentPid: process.ppid,
    pid: process.pid,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomId: () => crypto.randomUUID(),
    signal: stop.signal,
  });
  // Written whole before the exit below.
  if (output !== "") await new Promise((done) => process.stdout.write(`${output}\n`, done));
} finally {
  process.exit(0);
}
