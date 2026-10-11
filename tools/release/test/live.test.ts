import { describe, expect, it } from "vitest";
import { readLive } from "../src/live.ts";
import { fakeApi } from "./fakes.ts";

const live = { build: 95, commit: "25c5076" };
const previous = { build: 94, commit: "cc8e179" };

describe("readLive", () => {
  it("reads a split deployment by its larger share, and keeps the whole split", async () => {
    const api = fakeApi({ live, versions: [previous] });
    const split = [
      { version_id: "ingress-94-cc8e179", percentage: 90 },
      { version_id: "ingress-95-25c5076", percentage: 10 },
    ];
    api.active.set("kelpie-ingress", split);
    const ingress = (await readLive(api)).find((worker) => worker.spec.script === "kelpie-ingress");
    expect(ingress?.tag).toEqual(previous);
    expect(ingress?.traffic).toEqual(split);
  });

  it("collects only instance vars with a value", async () => {
    const api = fakeApi({
      live,
      vars: {
        "kelpie-ingress": {
          ACCESS_AUD: "",
          ACCESS_TEAM_DOMAIN: "https://team.example.com",
          OTHER: "x",
        },
      },
    });
    const ingress = (await readLive(api)).find((worker) => worker.spec.script === "kelpie-ingress");
    expect(ingress?.vars).toEqual({ ACCESS_TEAM_DOMAIN: "https://team.example.com" });
  });

  it("refuses a Worker that was never deployed", async () => {
    const api = fakeApi({ live });
    api.active.set("kelpie-admin-api", []);
    await expect(readLive(api)).rejects.toThrow("kelpie-admin-api has never been deployed");
  });
});
