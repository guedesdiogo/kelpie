import { homedir } from "node:os";
import { readConfig } from "./config.ts";
import { PROTOCOL, VERSION } from "./protocol.ts";
import { loadSecrets, RunnerConfigError } from "./secrets.ts";
import { createHandler } from "./server.ts";

// EX_CONFIG. The systemd unit doesn't restart the runner on it: a setting needs fixing first.
const EXIT_CONFIG = 78;

try {
  const config = readConfig(process.env, homedir());
  const secrets = loadSecrets(config.secretFile);
  const fetch = createHandler({ secrets, log: (entry) => console.log(JSON.stringify(entry)) });
  // Loopback only: the tunnel's connector reaches the runner there, and nothing else should.
  Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch });
  console.log(`kelpie-runner ${VERSION} (protocol ${PROTOCOL}) on 127.0.0.1:${config.port}`);
} catch (error) {
  if (!(error instanceof RunnerConfigError)) throw error;
  console.error(`kelpie-runner: ${error.message}`);
  process.exit(EXIT_CONFIG);
}
