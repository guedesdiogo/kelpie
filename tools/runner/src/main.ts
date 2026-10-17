import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { readConfig } from "./config.ts";
import { PROTOCOL, VERSION } from "./protocol.ts";
import { loadSecrets, RunnerConfigError } from "./secrets.ts";
import { createHandler } from "./server.ts";
import { Sessions } from "./sessions.ts";

// EX_CONFIG. The systemd unit doesn't restart the runner on it: a setting needs fixing first.
const EXIT_CONFIG = 78;

try {
  const config = readConfig(process.env, homedir());
  const secrets = loadSecrets(config.secretFile);
  // Claude Code runs in an empty folder of its own, which only the runner's user can open, and
  // keeps its sessions' transcripts for that folder.
  const cwd = config.workDir;
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const sessions = new Sessions({
    query,
    sessionExists: async (id) => (await getSessionInfo(id, { dir: cwd })) !== undefined,
    env: process.env,
    cwd,
    warn: (message) => console.error(`kelpie-runner: ${message}`),
  });
  const fetch = createHandler({
    secrets,
    log: (entry) => console.log(JSON.stringify(entry)),
    sessions,
  });
  // Loopback only: the tunnel's connector reaches the runner there, and nothing else should. A
  // turn's stream stays silent while Kelpie runs a tool, so idle connections aren't cut.
  Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    development: false,
    idleTimeout: 0,
    fetch,
  });
  console.log(`kelpie-runner ${VERSION} (protocol ${PROTOCOL}) on 127.0.0.1:${config.port}`);
} catch (error) {
  if (!(error instanceof RunnerConfigError)) throw error;
  console.error(`kelpie-runner: ${error.message}`);
  process.exit(EXIT_CONFIG);
}
