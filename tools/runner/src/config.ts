import { join } from "node:path";
import { RunnerConfigError } from "./secrets.ts";

/** The port the agent-computer spike used. The tunnel's VPC Service points at it. */
export const DEFAULT_PORT = 47832;

export interface RunnerConfig {
  port: number;
  secretFile: string;
  /**
   * The empty folder Claude Code runs in (#419): no project's files around it, and its sessions'
   * transcripts apart from the ones the owner's own sessions keep.
   */
  workDir: string;
}

/** The runner's settings, from its environment. It always listens on loopback, so no host is read. */
export function readConfig(env: Record<string, string | undefined>, home: string): RunnerConfig {
  const port =
    env.KELPIE_RUNNER_PORT === undefined ? DEFAULT_PORT : parsePort(env.KELPIE_RUNNER_PORT);
  const secretFile =
    env.KELPIE_RUNNER_SECRET_FILE || join(home, ".config", "kelpie-runner", "secret");
  const workDir =
    env.KELPIE_RUNNER_WORK_DIR || join(home, ".local", "state", "kelpie-runner", "claude-code");
  return { port, secretFile, workDir };
}

function parsePort(text: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!(port >= 1 && port <= 65_535)) {
    throw new RunnerConfigError(
      `KELPIE_RUNNER_PORT must be a port number, not ${JSON.stringify(text)}`,
    );
  }
  return port;
}
