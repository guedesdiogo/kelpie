// Claude Code's command hook for the VPS's sessions (ADR-0057 §2), which the owner installs in
// `~/.claude/settings.json` (docs/runner.md). Run with Bun. It reads the event from stdin, writes
// it to the spool in `~/.local/state/kelpie-runner/session-events/`, and always exits 0: a hook
// that fails never stops a session. It never touches the network.
import { homedir } from "node:os";
import { HOOK_DEADLINE_MS, runHook } from "../src/hook.ts";
import { ownUid } from "../src/secrets.ts";
import { spoolDirOf } from "../src/spool.ts";

const now = Date.now();
// Claude Code doesn't time out an async hook: this one stops itself.
setTimeout(() => process.exit(0), HOOK_DEADLINE_MS);
try {
  await runHook(process.stdin, { dir: spoolDirOf(homedir()), now, uid: ownUid() });
} finally {
  process.exit(0);
}
