import { describe, expect, it } from "vitest";
import { canonicalTimeZone } from "../src/index.ts";

describe("canonicalTimeZone", () => {
  it("accepts IANA names and returns their canonical spelling", () => {
    expect(canonicalTimeZone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(canonicalTimeZone("america/sao_paulo")).toBe("America/Sao_Paulo");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("Etc/GMT+3")).toBe("Etc/GMT+3");
  });

  it.each([
    ["an unknown name", "Mars/Phobos"],
    ["a UTC offset", "+03:00"],
    ["a negative UTC offset", "-03:00"],
    ["an empty string", ""],
    ["a name that is too long", `A/${"b".repeat(70)}`],
    ["a value that isn't a string", 3],
  ])("refuses %s", (_label, value) => {
    expect(canonicalTimeZone(value)).toBeNull();
  });
});
