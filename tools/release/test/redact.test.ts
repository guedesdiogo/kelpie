import { describe, expect, it } from "vitest";
import { maskCommands, redactor } from "../src/redact.ts";

describe("redactor", () => {
  it("hides a URL and its host, longest first, and masks each once", () => {
    const masked: string[] = [];
    const secrets = redactor((value) => masked.push(value));
    secrets.hide("https://kelpie.example.com");
    secrets.hide("https://kelpie.example.com");
    expect(masked).toEqual(["https://kelpie.example.com", "kelpie.example.com"]);
    expect(
      secrets.redact("Probe https://kelpie.example.com/health failed; domain kelpie.example.com"),
    ).toBe("Probe ***/health failed; domain ***");
  });

  it("hides every occurrence of an account id, and ignores values too short to matter", () => {
    const secrets = redactor(() => {});
    secrets.hide("0123456789abcdef");
    secrets.hide("ab");
    expect(secrets.redact("/accounts/0123456789abcdef/x/0123456789abcdef ab")).toBe(
      "/accounts/***/x/*** ab",
    );
  });
});

describe("maskCommands", () => {
  it("escapes the runner's percent encoding and masks each line", () => {
    expect(maskCommands("a%0Ab\nsecond")).toEqual(["::add-mask::a%250Ab", "::add-mask::second"]);
  });
});
