import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, readConfig } from "../src/config.ts";
import { RunnerConfigError } from "../src/secrets.ts";

describe("readConfig", () => {
  it("defaults to the spike's port, the secret file under ~/.config, a work folder of its own, ~/.claude and the hook's spool", () => {
    expect(readConfig({}, "/home/owner")).toEqual({
      port: DEFAULT_PORT,
      secretFile: "/home/owner/.config/kelpie-runner/secret",
      workDir: "/home/owner/.local/state/kelpie-runner/claude-code",
      claudeDir: "/home/owner/.claude",
      spoolDir: "/home/owner/.local/state/kelpie-runner/session-events",
    });
  });

  it("takes the port, the secret file, the work folder and Claude Code's folder from the environment", () => {
    expect(
      readConfig(
        {
          KELPIE_RUNNER_PORT: "48000",
          KELPIE_RUNNER_SECRET_FILE: "/etc/kelpie/secret",
          KELPIE_RUNNER_WORK_DIR: "/srv/kelpie-claude",
          KELPIE_RUNNER_CLAUDE_DIR: "/srv/claude",
        },
        "/home/owner",
      ),
    ).toEqual({
      port: 48000,
      secretFile: "/etc/kelpie/secret",
      workDir: "/srv/kelpie-claude",
      claudeDir: "/srv/claude",
      spoolDir: "/home/owner/.local/state/kelpie-runner/session-events",
    });
  });

  it.each(["0", "65536", "80a", "-1", " "])("refuses the port %j", (port) => {
    expect(() => readConfig({ KELPIE_RUNNER_PORT: port }, "/home/owner")).toThrow(
      RunnerConfigError,
    );
  });
});
