import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, readConfig } from "../src/config.ts";
import { RunnerConfigError } from "../src/secrets.ts";

describe("readConfig", () => {
  it("defaults to the spike's port, the secret file under ~/.config and a work folder of its own", () => {
    expect(readConfig({}, "/home/owner")).toEqual({
      port: DEFAULT_PORT,
      secretFile: "/home/owner/.config/kelpie-runner/secret",
      workDir: "/home/owner/.local/state/kelpie-runner/claude-code",
    });
  });

  it("takes the port, the secret file and the work folder from the environment", () => {
    expect(
      readConfig(
        {
          KELPIE_RUNNER_PORT: "48000",
          KELPIE_RUNNER_SECRET_FILE: "/etc/kelpie/secret",
          KELPIE_RUNNER_WORK_DIR: "/srv/kelpie-claude",
        },
        "/home/owner",
      ),
    ).toEqual({ port: 48000, secretFile: "/etc/kelpie/secret", workDir: "/srv/kelpie-claude" });
  });

  it.each(["0", "65536", "80a", "-1", " "])("refuses the port %j", (port) => {
    expect(() => readConfig({ KELPIE_RUNNER_PORT: port }, "/home/owner")).toThrow(
      RunnerConfigError,
    );
  });
});
