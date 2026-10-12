// Runs before every test file (vitest.config.ts `setupFiles`), so each one, a new one too, cleans
// up after its tests the same way (#245).
import { reset } from "cloudflare:test";
import { afterEach } from "vitest";
import { replaceBackendForTesting, replaceGatewayForTesting } from "../src/index.ts";

afterEach(async () => {
  replaceBackendForTesting(undefined);
  replaceGatewayForTesting(undefined);
  // A test's vaults go, alarms and all (#223): one left with an alarm wakes in a later test, where
  // it syncs with that test's backend and asks that test's model.
  await reset();
});
