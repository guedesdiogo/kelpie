// One tool input per redaction rule of docs/runner.md ("Secrets never leave"), as Claude Code would
// ask permission for it, with the part of it that must never leave the server. The permission
// hook's tests and the runner's both run them: a request's input is redacted twice (ADR-0069 §4).
// The fake keys are built here, piece by piece, so no scanner takes this file for a leak.

const key = (...parts: string[]) => parts.join("");

/** [the rule, the tool's input, what must not survive]. */
export const SECRET_SAMPLES: readonly [string, Record<string, unknown>, string][] = [
  ["a NAME=value", { command: "API_KEY=abc-def-ghi ./deploy.sh" }, "abc-def-ghi"],
  ["a flag's --name=value", { command: "mysql --password=hunter2x -h db" }, "hunter2x"],
  ["a flag's --name value", { command: "gh auth login --token tk_live_9a8b7c" }, "tk_live_9a8b7c"],
  [
    "a quoted name's value, as JSON writes it",
    { url: "https://api.example/x", body: { api_key: "quoted-value-123" } },
    "quoted-value-123",
  ],
  [
    "a header within a quoted command",
    { command: `curl -H "x-api-key: hdr-secret-77" https://api.example` },
    "hdr-secret-77",
  ],
  [
    "a YAML line's name: value",
    { file_path: "/srv/app.yml", content: "db:\n  password: yaml-pass-55\n" },
    "yaml-pass-55",
  ],
  [
    "a YAML value on the lines below its name",
    { file_path: "/srv/app.yml", content: "secret: |\n  block-line-one\n  block-line-two\n" },
    "block-line-one",
  ],
  [
    "a URL's password",
    { command: "psql postgres://kelpie:url-pass-31@db.example:5432/app" },
    "url-pass-31",
  ],
  [
    "curl's -u user:password",
    { command: "curl -u admin:curl-pass-12 https://x.test" },
    "curl-pass-12",
  ],
  [
    "a Slack webhook's path",
    {
      command: key(
        "curl -X POST https://hooks.slack.com/services/",
        "T0123ABCD/B0456EFGH/",
        "aBcDeFgHiJkLmNoPqRsTuVwX",
      ),
    },
    "aBcDeFgHiJkLmNoPqRsTuVwX",
  ],
  [
    "a bearer token",
    { command: "curl https://api.example -H 'Authorization: Bearer abc.DEF-123_xyz'" },
    "abc.DEF-123_xyz",
  ],
  [
    "a key of a known format",
    { command: key("export K=1; echo ", "ghp", "_", "A1b2C3d4".repeat(5)) },
    "A1b2C3d4A1b2",
  ],
  [
    "a PEM block",
    {
      file_path: "/home/owner/.ssh/id",
      content: key(
        "-----BEGIN ",
        "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END ",
        "OPENSSH PRIVATE KEY-----",
      ),
    },
    "b3BlbnNzaC1rZXk",
  ],
  ["a run of 32 hex digits or more", { command: `echo ${"a1".repeat(20)} > key` }, "a1a1a1a1a1a1"],
  [
    "a run of 32 base64 characters or more",
    { command: key("echo ", "dGhpcyBpcyBh", "IHNlY3JldCBr", "ZXkgMTIzNDU2Nzg5MA== > k") },
    "IHNlY3JldCBr",
  ],
];
