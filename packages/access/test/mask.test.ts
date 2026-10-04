import { describe, expect, it } from "vitest";
import { maskIdentityValue } from "../src/index.ts";

describe("maskIdentityValue", () => {
  it("keeps the first two and last two characters", () => {
    expect(maskIdentityValue("+5511987654321")).toBe("+5••••••••••21");
    expect(maskIdentityValue("owner@example.com")).toBe("ow•••••••••••••om");
  });

  it("hides short values entirely", () => {
    expect(maskIdentityValue("1001")).toBe("••••");
    expect(maskIdentityValue("")).toBe("");
  });

  it("counts characters, not code units", () => {
    expect(maskIdentityValue("ana👋xyz")).toBe("an•••yz");
  });
});
