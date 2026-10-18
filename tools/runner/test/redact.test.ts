import { describe, expect, it } from "vitest";
import { MAX_EXCERPT_CHARS } from "../src/protocol.ts";
import { cut, excerptOf, REDACTED, redact } from "../src/redact.ts";
import { RUNNER_SECRET } from "./fake-vps.ts";

// The fake keys are built here, piece by piece, so no scanner takes this file for one that leaks.
const key = (...parts: string[]) => parts.join("");
const ANTHROPIC = key("sk-", "ant-api03-", "Ab3dEf6hIj9kLm2nOp5qRs8t");
const OPENAI = key("sk-", "proj-", "Zy1xWv4uTs7rQp0oNm3lKj6i");
const GITHUB_PAT = key("ghp", "_", "A1b2C3d4".repeat(5));
const GITHUB_OAUTH = key("gho", "_", "Q9w8E7r6".repeat(5));
const GITHUB_FINE = key("github", "_pat_", "11ABCDEFG0", "_", "a1B2c3D4e5".repeat(6));
const AWS = key("AKIA", "Z7Q4", "M2X9", "L5K8", "P3N6");
const BASE64 = key("dGhpcyBpcyBh", "IHNlY3JldCBr", "ZXkgMTIzNDU2Nzg5MA==");
const BASE64URL = key("Xk9_aB3-", "Qr7Tz2W", "p5Ln8Vc4", "Jd6Hs1Fg0");

describe("redact", () => {
  it.each([
    ["the runner's own secret, by value", `the secret is ${RUNNER_SECRET}.`],
    ["a secret of another shape, by value", "it printed correct-horse-battery-staple!"],
  ])("removes %s", (_, text) => {
    const redacted = redact(text, [RUNNER_SECRET, "correct-horse-battery-staple"]);
    expect(redacted).toContain(REDACTED);
    expect(redacted).not.toContain(RUNNER_SECRET);
    expect(redacted).not.toContain("horse");
  });

  it.each([
    ["API_KEY=abc def ghi", `API_KEY=${REDACTED}`],
    ["export GITHUB_TOKEN='abc'", `export GITHUB_TOKEN=${REDACTED}`],
    ["  db.password = hunter2 # old", `  db.password =${REDACTED}`],
    ["client_secret=s3cr3t", `client_secret=${REDACTED}`],
    ["Stripe_Key=x", `Stripe_Key=${REDACTED}`],
    // It errs toward redacting: any name that says token.
    ["tokens = 3", `tokens =${REDACTED}`],
    ["GH_TOKEN=abc123 gh pr list", `GH_TOKEN=${REDACTED}`],
  ])("redacts a NAME=value line to its end: %s", (line, expected) => {
    expect(redact(`before\n${line}\nafter`)).toBe(`before\n${expected}\nafter`);
  });

  it.each([
    ["run GH_TOKEN=abc123 gh pr list", `run GH_TOKEN=${REDACTED} gh pr list`],
    ['run with ACCESS_TOKEN="a b c" now', `run with ACCESS_TOKEN=${REDACTED} now`],
    [
      "open https://x.test/cb?token=abc&next=1 then",
      `open https://x.test/cb?token=${REDACTED} then`,
    ],
    ["set password='p w' here", `set password=${REDACTED} here`],
  ])("redacts NAME=value within a line: %s", (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each([
    "if (token == expected) return;",
    "const pick = (key) => key.name;",
    "the key is in the vault",
  ])("leaves code and prose that only mention a name: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("redacts a bearer token, whatever its case, and leaves the word", () => {
    expect(redact("curl -H 'Authorization: Bearer abc.DEF-123_xyz~+/='")).toBe(
      `curl -H 'Authorization: Bearer ${REDACTED}'`,
    );
    expect(redact("bearer   0123456789")).toBe(`bearer   ${REDACTED}`);
    expect(redact("Bearer tokens are short-lived")).toBe("Bearer tokens are short-lived");
  });

  it.each([
    ["an Anthropic key", ANTHROPIC],
    ["an OpenAI key", OPENAI],
    ["a GitHub token", GITHUB_PAT],
    ["a GitHub OAuth token", GITHUB_OAUTH],
    ["a GitHub fine-grained token", GITHUB_FINE],
    ["an AWS access key id", AWS],
  ])("redacts %s", (_, secret) => {
    const redacted = redact(`use (${secret}) here`);
    expect(redacted).toBe(`use (${REDACTED}) here`);
  });

  it("leaves what only starts like a key", () => {
    for (const text of ["task-runner-is-fine", "sk-short", "ghp_short", "AKIA1234"]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("redacts a PEM block whole, and what is left of one cut short", () => {
    const pem = key(
      "-----BEGIN ",
      "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END ",
      "OPENSSH PRIVATE KEY-----",
    );
    expect(redact(`key:\n${pem}\ndone`)).toBe(`key:\n${REDACTED}\ndone`);
    expect(redact(`key:\n${pem.slice(0, 50)}`)).toBe(`key:\n${REDACTED}`);
  });

  it("redacts runs of 32 hex digits or more, and leaves shorter ones", () => {
    expect(redact(`commit ${"a1".repeat(20)} merged`)).toBe(`commit ${REDACTED} merged`);
    expect(redact("commit 19d3f93 merged")).toBe("commit 19d3f93 merged");
    expect(redact(`id ${"f".repeat(31)}`)).toBe(`id ${"f".repeat(31)}`);
  });

  it("redacts base64 and base64url runs of 32 or more that mix cases and digits", () => {
    expect(redact(`blob ${BASE64} end`)).toBe(`blob ${REDACTED} end`);
    expect(redact(`blob ${BASE64URL} end`)).toBe(`blob ${REDACTED} end`);
  });

  it.each([
    "aaaaaaaa-1111-4222-8333-444444444444",
    "tools/runner/src/session-files.ts",
    "/home/owner/Repos/kelpie/.claude/worktrees/kelpie-ai-memory-review-1e606f",
    "THIS_IS_A_LONG_CONSTANT_NAME_WITH_NO_LOWERCASE_2",
    "https://github.com/guedesdiogo/kelpie/pull/433",
  ])("leaves a long run that doesn't mix cases and digits: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("errs toward redacting a long path that mixes cases and digits", () => {
    expect(redact("/home/owner/Repos/gclinic-r3-api/src/modules")).toBe(REDACTED);
  });

  it("is idempotent, so the runner can redact the hook's output again", () => {
    const text = `API_KEY=x\nBearer ${RUNNER_SECRET}\n${GITHUB_PAT}`;
    const once = redact(text, [RUNNER_SECRET]);
    expect(redact(once, [RUNNER_SECRET])).toBe(once);
  });

  it("takes no secret by value when none is given, or an empty one", () => {
    expect(redact("plain text", [""])).toBe("plain text");
  });
});

describe("excerptOf", () => {
  it("keeps a text within the bound as it is", () => {
    expect(excerptOf("Done. The PR is open.", 500)).toBe("Done. The PR is open.");
    expect(excerptOf("x".repeat(500), 500)).toBe("x".repeat(500));
  });

  it("drops the word the cut falls in", () => {
    expect(excerptOf("one two three", 9)).toBe("one two");
    expect(excerptOf("one two three", 7)).toBe("one two");
    expect(excerptOf("one two\nthree", 10)).toBe("one two");
    expect(excerptOf("one  two", 4)).toBe("one");
  });

  it("cuts a text that is one long word where it reaches the bound, never inside a pair", () => {
    expect(excerptOf("a".repeat(20), 10)).toBe("a".repeat(10));
    expect(excerptOf(` ${"b".repeat(20)}`, 10)).toBe(` ${"b".repeat(9)}`);
    expect(excerptOf(`${"c".repeat(9)}🦭`, 10)).toBe("c".repeat(9));
  });

  it("leaves no part of a token that straddles the cut, since the hook redacts first", () => {
    const reply = `${"word ".repeat(98)}ok ${GITHUB_PAT} and more`;
    expect(reply.indexOf(GITHUB_PAT)).toBeLessThan(MAX_EXCERPT_CHARS);
    expect(reply.indexOf(GITHUB_PAT) + GITHUB_PAT.length).toBeGreaterThan(MAX_EXCERPT_CHARS);
    const excerpt = excerptOf(redact(reply), MAX_EXCERPT_CHARS);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    // Cutting first would leave its start, too short for any pattern to know it.
    const start = GITHUB_PAT.slice(0, MAX_EXCERPT_CHARS - reply.indexOf(GITHUB_PAT));
    expect(redact(reply.slice(0, MAX_EXCERPT_CHARS))).toContain(start);
    expect(excerpt).not.toContain(start);
    expect(excerpt.endsWith("ok")).toBe(true);
  });
});

describe("cut", () => {
  it("cuts at the bound, never inside a surrogate pair", () => {
    expect(cut("abc", 5)).toBe("abc");
    expect(cut("abcdef", 3)).toBe("abc");
    expect(cut("ab🦭", 3)).toBe("ab");
  });
});
