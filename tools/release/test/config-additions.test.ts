import { describe, expect, it } from "vitest";
import { withAdditions } from "../src/config-additions.ts";

const RUNNER = { binding: "RUNNER", service_id: "e6a0817c-79c5-40ca-9776-a1c019defe70" };

describe("withAdditions", () => {
  it("adds the bindings to the committed config, comments and all", () => {
    const committed = `{
  // Reached only through service bindings.
  "name": "kelpie-channel-egress",
  "main": "src/index.ts",
  "durable_objects": { "bindings": [{ "name": "SECRET_STORE", "class_name": "SecretStore" }] },
}`;
    expect(JSON.parse(withAdditions(committed, { vpc_services: [RUNNER] }))).toEqual({
      name: "kelpie-channel-egress",
      main: "src/index.ts",
      durable_objects: { bindings: [{ name: "SECRET_STORE", class_name: "SecretStore" }] },
      vpc_services: [RUNNER],
    });
  });

  it("keeps the VPC Services the config already has", () => {
    const other = { binding: "OTHER", service_id: "daf43e8c-a81a-4242-9912-4a2ebe4fdd79" };
    const committed = JSON.stringify({ name: "w", vpc_services: [other] });
    expect(JSON.parse(withAdditions(committed, { vpc_services: [RUNNER] })).vpc_services).toEqual([
      other,
      RUNNER,
    ]);
  });
});
