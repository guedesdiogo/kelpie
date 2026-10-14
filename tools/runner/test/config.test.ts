import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, readConfig } from "../src/config.ts";
import { RunnerConfigError } from "../src/secrets.ts";

describe("readConfig", () => {
  it("defaults to the spike's port and the secret file under ~/.config", () => {
    expect(readConfig({}, "/home/owner")).toEqual({
      port: DEFAULT_PORT,
      secretFile: "/home/owner/.config/kelpie-runner/secret",
    });
  });

  it("takes the port and the secret file from the environment", () => {
    expect(
      readConfig(
        { KELPIE_RUNNER_PORT: "48000", KELPIE_RUNNER_SECRET_FILE: "/etc/kelpie/secret" },
        "/home/owner",
      ),
    ).toEqual({ port: 48000, secretFile: "/etc/kelpie/secret" });
  });

  it.each(["0", "65536", "80a", "-1", " "])("refuses the port %j", (port) => {
    expect(() => readConfig({ KELPIE_RUNNER_PORT: port }, "/home/owner")).toThrow(
      RunnerConfigError,
    );
  });
});
