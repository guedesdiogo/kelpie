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
    ["DB_PASS=hunter2", `DB_PASS=${REDACTED}`],
    ["MYSQL_PWD=hunter2", `MYSQL_PWD=${REDACTED}`],
    ["GOOGLE_CREDENTIALS={...}", `GOOGLE_CREDENTIALS=${REDACTED}`],
    ["AUTH_HEADER=x", `AUTH_HEADER=${REDACTED}`],
    ["SESSION_COOKIE=abc", `SESSION_COOKIE=${REDACTED}`],
    ["SENTRY_DSN=https://k@o1.ingest.example/1", `SENTRY_DSN=${REDACTED}`],
    ["WEBHOOK_SIGNATURE=v1abc", `WEBHOOK_SIGNATURE=${REDACTED}`],
    ["PASSPHRASE=correct horse", `PASSPHRASE=${REDACTED}`],
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
    // Counts of tokens, the shell's folder, and a commit's author are no secrets.
    "max_tokens=4096",
    "tokens = 3",
    "PWD=/home/owner/Repos/kelpie",
    "OLDPWD=/home/owner",
    "GIT_AUTHOR_NAME=Diogo",
    "author: Diogo Guedes",
    // Only `authorization` says auth among its kin: `authorized` and `authorize` say a state.
    "authorized: yes",
    "isAuthorized = check()",
    "authority: https://login.example",
    "authors: 3",
    // Test results and statuses: pass and auth as words.
    "Passed: 458/458",
    "Pass: all green",
    "Auth: ok",
    "pass: 458/458",
    "Pass: passed",
    "auth: n/a",
    "AUTH: Off",
    "pass: yes.",
    "auth: 12",
    "pass: 458",
    "Pass: 12345/12345",
    "TESTS_PASSED=458",
    "PASSING=12",
    "bun test --passWithNoTests src",
    "vitest run --passWithNoTests",
  ])("leaves code and prose that only mention a name: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["mysql --password=hunter2 -h db", `mysql --password=${REDACTED} -h db`],
    ["gh auth login --token=abc123", `gh auth login --token=${REDACTED}`],
    ["tool --api-key=xyz789 run", `tool --api-key=${REDACTED} run`],
    ["mysql --password hunter2 -h db", `mysql --password ${REDACTED} -h db`],
    ['tool --api-key "a b" run', `tool --api-key ${REDACTED} run`],
    ["curl -u admin:hunter2 https://x.test", `curl -u admin:${REDACTED} https://x.test`],
    [
      "curl --user 'admin:hunter2' https://x.test",
      `curl --user 'admin:${REDACTED}' https://x.test`,
    ],
  ])("redacts a command's secret flag: %s", (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it("leaves flags whose value isn't one, and `-u` without a password", () => {
    for (const text of ["git push -u origin main", "tool --password --verbose", "sort -u list"]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("redacts a quoted name's value, as JSON writes it, and leaves its counts and nulls", () => {
    const json =
      '{"api_key": "abc def", "password":"x", "max_tokens": 1024, "token": null, \'auth\': \'y\'}';
    expect(redact(json)).toBe(
      `{"api_key": "${REDACTED}", "password":"${REDACTED}", "max_tokens": 1024, "token": null, 'auth': '${REDACTED}'}`,
    );
    expect(redact('{"session_token": abc123}')).toBe(`{"session_token": ${REDACTED}}`);
  });

  it.each([
    // A PIN or a one-time code is a bare number of four digits or more (#441).
    ['{"pass": 123456}', `{"pass": ${REDACTED}}`],
    ['{"auth": 481516234}', `{"auth": ${REDACTED}}`],
    ['{"password": 12345678, "user": "ana"}', `{"password": ${REDACTED}, "user": "ana"}`],
    ["{'auth': 123456}", `{'auth': ${REDACTED}}`],
    ['{"token": 4815.1623}', `{"token": ${REDACTED}}`],
    // At the bounds: four digits, or a fourth decimal.
    ['{"pass": 1234}', `{"pass": ${REDACTED}}`],
    ['{"key": 1.1234}', `{"key": ${REDACTED}}`],
  ])("redacts a quoted name's bare number that could be a PIN: %s", (json, expected) => {
    expect(redact(json)).toBe(expected);
  });

  it.each([
    '{"pass": 458, "auth": -1, "key_count": 12.5}',
    '{"max_tokens": 1024, "retries": 3}',
    '{"pass": 999, "key": 123.456}',
  ])("leaves a quoted name's short number, a count: %s", (json) => {
    expect(redact(json)).toBe(json);
  });

  it.each([
    ["password: hunter2 and more", `password: ${REDACTED}`],
    ["  - auth_token: abc", `  - auth_token: ${REDACTED}`],
    ['"client_secret": "x"', `"client_secret": "${REDACTED}"`],
    ["Authorization: Basic Zm9vOmJhcg==", `Authorization: Basic ${REDACTED}`],
    ["x-api-key: abc123", `x-api-key: ${REDACTED}`],
    ["Cookie: session=abc; theme=dark", `Cookie: ${REDACTED}`],
    // With no space after the colon, too (#441).
    ["pass:123456", `pass:${REDACTED}`],
    ["AUTH:123456", `AUTH:${REDACTED}`],
    ["password:hunter2", `password:${REDACTED}`],
    ["  - api_key:abc123", `  - api_key:${REDACTED}`],
  ])("redacts a YAML or header line's value: %s", (line, expected) => {
    expect(redact(`before\n${line}\nafter`)).toBe(`before\n${expected}\nafter`);
  });

  it.each([
    // `Authorization` says auth, though `author` doesn't (#458).
    ["Authorization: abc123xyz", `Authorization: ${REDACTED}`],
    ["authorization: hunter2", `authorization: ${REDACTED}`],
    ["curl -H 'Authorization: abc123xyz' x", `curl -H 'Authorization: ${REDACTED}' x`],
    ["proxy-authorization:hunter2", `proxy-authorization:${REDACTED}`],
    // A known scheme stays in front; another is part of the secret.
    [
      'Authorization: Digest username="a", response="abc123xyz"',
      `Authorization: Digest ${REDACTED}`,
    ],
    ["Authorization: Negotiate YIIabc123", `Authorization: Negotiate ${REDACTED}`],
    ["Authorization: ApiKey abc123xyz", `Authorization: ${REDACTED}`],
  ])("redacts an Authorization header's value, keeping its scheme: %s", (line, expected) => {
    expect(redact(`before\n${line}\nafter`)).toBe(`before\n${expected}\nafter`);
  });

  it.each([
    // A value that only starts with a type word is no type (#458).
    ["token: any-secret", `token: ${REDACTED}`],
    ["secret: never!", `secret: ${REDACTED}`],
    ["pass: null.abc", `pass: ${REDACTED}`],
    ["password:any-secret", `password:${REDACTED}`],
  ])("redacts a value that only starts with a type word: %s", (line, expected) => {
    expect(redact(line)).toBe(expected);
  });

  it.each([
    // An empty value or a block indicator puts it on the lines below, more indented (#458).
    ["password:\n  hunter2", `password:\n  ${REDACTED}`],
    ["password: |\n  hunter2\n  more", `password: |\n  ${REDACTED}`],
    ["  - token:\n      abc123", `  - token:\n      ${REDACTED}`],
    ["api_key: >-\n    abc\n      def", `api_key: >-\n    ${REDACTED}`],
    ["password:\r\n  hunter2", `password:\r\n  ${REDACTED}`],
    ["password: |\r\n  hunter2", `password: |\r\n  ${REDACTED}`],
    ["token:\n  -abc123", `token:\n  ${REDACTED}`],
    // A plain value runs on up to a line that is a key's.
    ["password:\n  hunter2\n  more\n  next: x", `password:\n  ${REDACTED}\n  next: x`],
    // A block's lines are its value, whatever they look like.
    ["secret: |2+\n  user: admin\n  - item", `secret: |2+\n  ${REDACTED}`],
    // 20 lines at most, all of a value that long.
    [`key: |${"\n  line".repeat(20)}`, `key: |\n  ${REDACTED}`],
  ])("redacts a YAML value on the more-indented lines below its name: %j", (text, expected) => {
    expect(redact(`before\n${text}\nafter`)).toBe(`before\n${expected}\nafter`);
  });

  it.each([
    // A nested mapping or a list isn't a value that runs on, nor a line no more indented.
    "auth:\n  method: basic",
    "auth:\n  method:\tbasic",
    "auth:\n  basic:",
    "token:\n  - abc",
    "token:\n  -",
    "key:\n\ntext",
    "key:\ntext",
  ])("leaves a nested mapping, a list, or a line no more indented, below a name: %j", (text) => {
    expect(redact(text)).toBe(text);
  });

  it.each([
    "token:",
    "  token: string;",
    "password: boolean,",
    "auth: null",
    "token: string | null;",
    "token: string[];",
    "auth: null\r\nnext",
    "The token: we rotate it",
    "token:   ",
    `token:${" ".repeat(9)}`,
    "auth:ok",
    "pass:458/458",
    "password:string;",
    "https://example.com/token:abc",
  ])("leaves a line that only names one, or a type: %s", (line) => {
    expect(redact(line)).toBe(line);
  });

  it("redacts a header within a quoted command, keeping its scheme", () => {
    expect(redact(`curl -H 'Authorization: Basic Zm9vOmJhcg==' -H "x-api-key: abc123" x`)).toBe(
      `curl -H 'Authorization: Basic ${REDACTED}' -H "x-api-key: ${REDACTED}" x`,
    );
  });

  it.each([
    ["pass=hunter2", `pass=${REDACTED}`],
    ["password: hunter2", `password: ${REDACTED}`],
    ["auth_token: abc", `auth_token: ${REDACTED}`],
    ["Authorization: Basic Zm9vOmJhcg==", `Authorization: Basic ${REDACTED}`],
    ["run --pass hunter2", `run --pass ${REDACTED}`],
    ["pass: hunter2", `pass: ${REDACTED}`],
    ["auth: abcdef123", `auth: ${REDACTED}`],
    ["Pass: all green-ish", `Pass: ${REDACTED}`],
    // A PIN or a one-time code is a bare number of four digits or more; a count has a slash.
    ["pass: 123456", `pass: ${REDACTED}`],
    ["auth: 481516234", `auth: ${REDACTED}`],
    ["Pass: 1234.", `Pass: ${REDACTED}`],
  ])("still redacts pass and auth where they name a secret: %s", (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it("redacts the password of a URL whose user is empty", () => {
    expect(redact("REDIS_URL is redis://:s3cret@cache.example:6379/0")).toBe(
      `REDIS_URL is redis://:${REDACTED}@cache.example:6379/0`,
    );
  });

  it("redacts a bare 40-character AWS secret key, slashes and pluses included", () => {
    for (const secret of [
      key("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
      key("9dP+aB3/", "QzX1y7W", "kLm0Np2+", "Rs5Tu8Vw", "Yz4C6e1Qx"),
    ]) {
      expect(secret).toHaveLength(40);
      expect(redact(`aws key ${secret} here`)).toBe(`aws key ${REDACTED} here`);
    }
  });

  it.each([
    "/home/owner/Repos/gclinic-r3-api/src/modules/patients",
    "Repos/gclinic/r3/api/src/modules/patients",
    "src/Components2/Button/IconButtonWithTip",
    "/src/Components2/Button/IconButtonWithTi",
    "src/Components2/Button/IconButtonWithTi/",
    "app/Models2/Users/Profile/Edit/Views/Tab",
    "/home/ubuntu/Repos/gclinic-r3-api/src/modules",
    "/srv/Projects2/Kelpie/apps/channel-egress/src",
    "/Users/Owner/Library/Caches/Kelpie2/Sessions",
    "packages/Memory2/source/Sanitize/rules/tests",
  ])("leaves a path of 40 characters or so: %s", (path) => {
    expect(redact(path)).toBe(path);
  });

  it("redacts random base64 keys whole, with a slash or not, almost always", () => {
    // A seeded generator, so the run is the same every time.
    let state = 0x2545f491;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const random = (length: number) =>
      Array.from({ length }, () => alphabet[Math.floor(next() * 64)]).join("");
    const shapes = [
      ["AWS-shaped", () => random(40), 0.005],
      ["openssl rand -base64 32", () => `${random(43)}=`, 0.005],
      ["64 characters", () => random(64), 0],
      ["88 characters", () => `${random(86)}==`, 0],
    ] as const;
    const started = performance.now();
    for (const [, make, most] of shapes) {
      let leaked = 0;
      for (let trial = 0; trial < 2_000; trial += 1) {
        const secret = make();
        if (redact(`key ${secret} here`).includes(secret)) leaked += 1;
      }
      expect(leaked / 2_000).toBeLessThanOrEqual(most);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("redacts a Slack webhook's secret path", () => {
    const hook = key(
      "https://hooks.slack.com/services/",
      "T0123ABCD/",
      "B0456EFGH/",
      "aBcDeFgHiJkLmNoPqRsTuVwX",
    );
    expect(redact(`post to ${hook} now`)).toBe(
      `post to https://hooks.slack.com/services/${REDACTED} now`,
    );
  });

  it("redacts the password in a URL's userinfo, and leaves the rest", () => {
    expect(redact("connect to postgres://kelpie:s3cret@db.example:5432/app now")).toBe(
      `connect to postgres://kelpie:${REDACTED}@db.example:5432/app now`,
    );
    expect(redact("see https://github.com/guedesdiogo/kelpie and git@github.com:x/y")).toBe(
      "see https://github.com/guedesdiogo/kelpie and git@github.com:x/y",
    );
  });

  it("redacts a bearer or basic token, whatever its case, and leaves the words", () => {
    expect(redact("send Authorization Bearer abc.DEF-123_xyz~+/=")).toBe(
      `send Authorization Bearer ${REDACTED}`,
    );
    expect(redact("bearer   0123456789")).toBe(`bearer   ${REDACTED}`);
    expect(redact("basic Zm9vOmJhcg== ok")).toBe(`basic ${REDACTED} ok`);
    expect(redact("token eyJhbGciOiJIUzI1NiJ9")).toBe(`token ${REDACTED}`);
    for (const text of [
      "Bearer tokens are short-lived",
      "Bearer authentication",
      "Bearer Authentication",
      "Basic usage first",
    ]) {
      expect(redact(text)).toBe(text);
    }
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
    expect(redact(`id ${"a1".repeat(16)} merged`)).toBe(`id ${REDACTED} merged`);
    expect(redact(`id ${"a1".repeat(20)} merged`)).toBe(`id ${REDACTED} merged`);
    expect(redact(`id ${"A1".repeat(32)}`)).toBe(`id ${REDACTED}`);
    expect(redact("commit 19d3f93 merged")).toBe("commit 19d3f93 merged");
    expect(redact(`id ${"f".repeat(31)}`)).toBe(`id ${"f".repeat(31)}`);
  });

  it("leaves a commit's 40-hex SHA where the text says it is one", () => {
    const sha = "19d3f93a6b0c1d2e3f40516273849a0b1c2d3e4f";
    for (const text of [
      `commit ${sha}`,
      `Merged ${sha} into main`,
      `https://github.com/guedesdiogo/kelpie/commit/${sha}`,
      `sha: ${sha}`,
      `HEAD = ${sha}`,
      `revert #${sha}`,
      `parent - ${sha}`,
    ]) {
      expect(redact(text)).toBe(text);
    }
    // Without that, or longer, or in capitals, a run of hex reads as a secret.
    expect(redact(`it printed ${sha}`)).toBe(`it printed ${REDACTED}`);
    // Words that only start like one aren't a commit's context, and a token stays one.
    for (const lead of ["header", "review of", "the shared secret is", "headers:", "treetop"]) {
      expect(redact(`${lead} ${sha}`)).toBe(`${lead} ${REDACTED}`);
    }
    // Only separators may stand between the word and the hex: more words name something else.
    for (const lead of [
      "sha1 secret:",
      "blob storage key:",
      "merge webhook secret:",
      "HEAD is now at",
    ]) {
      expect(redact(`${lead} ${sha}`)).toBe(`${lead} ${REDACTED}`);
    }
    expect(redact(`GITHUB_TOKEN=${sha}`)).toBe(`GITHUB_TOKEN=${REDACTED}`);
    expect(redact(`my github token is ${sha}`)).toBe(`my github token is ${REDACTED}`);
    expect(redact(`commit ${sha}${"0".repeat(24)}`)).toBe(`commit ${REDACTED}`);
    expect(redact(`commit ${sha.toUpperCase()}`)).toBe(`commit ${REDACTED}`);
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

  it("leaves a long path, even one that mixes cases and digits", () => {
    for (const path of [
      "/home/owner/Repos/gclinic-r3-api/src/modules",
      "src/Components2/Button/IconButtonWithTooltip3.tsx",
    ]) {
      expect(redact(path)).toBe(path);
    }
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

describe("redact's cost", () => {
  it.each([
    ["a-", "a-"],
    ["a.", "a."],
    ["-u=", "-u="],
    ["--a", "--a"],
    ["a.://", "a."],
    ["a:", "a:"],
    ['"a', '"a'],
    ["'a: ", "'a: "],
    ["a=", "a="],
    ["key-", "key-"],
    ["key.", "key."],
    ["--key ", "--key "],
    ["a/", "a/"],
    ["Ab1+", "Ab1+"],
    ["Bearer ", "Bearer "],
    ["sk-", "sk-"],
    ["-----BEGIN A-----", "-----BEGIN A-----"],
    ["x://:", "x://:"],
    ["commit ", "commit "],
    // A name with nothing after it, then lines more indented, each a key's or a value's (#458).
    ["key:\\n ", "key:\n "],
    ["key: |\\n ", "key: |\n "],
    ["key:\\n a", "key:\n a"],
  ])("takes linear time on %j: 8 times the text, well under quadratic cost", (_, unit) => {
    const of = (length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    // The best of three runs, after a warm-up, so a pause of the collector doesn't count.
    const cost = (text: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        redact(text, ["correct horse battery staple"]);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = of(25_000);
    const large = of(200_000);
    redact(small);
    const smallCost = cost(small);
    const largeCost = cost(large);
    // Linear costs about 8 times as much on 8 times the text, and quadratic about 64 times; it
    // took 12 to 60 s on the larger text. The bound sits far from both, and the floor keeps a
    // sub-millisecond baseline from turning a CI runner's noise into a failure.
    expect(largeCost / Math.max(smallCost, 5)).toBeLessThan(24);
    expect(largeCost).toBeLessThan(1_000);
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
