import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inboxLineOf, isInbox, postToInbox } from "../src/inbox.ts";
import { ownUid } from "../src/secrets.ts";

let root: string;
let socks: string;
let servers: Server[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "krb-"));
  socks = join(root, "cc-socks");
  mkdirSync(socks, { mode: 0o700 });
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  rmSync(root, { recursive: true, force: true });
});

/** A session's inbox, as Claude Code binds one: it reads lines until the poster ends. */
async function inbox(path: string, { answer = false } = {}): Promise<string[]> {
  const lines: string[] = [];
  const server = createServer((connection) => {
    let text = "";
    connection.on("data", (chunk) => {
      text += chunk;
      if (answer) connection.write('{"type":"peer_message_hold"}\n');
    });
    connection.on("end", () => {
      lines.push(...text.split("\n").filter((line) => line !== ""));
      connection.end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(path, done));
  return lines;
}

describe("isInbox", () => {
  it("takes a socket of the runner's user, in a directory no one else may open", async () => {
    const path = join(socks, "1.sock");
    await inbox(path);
    expect(isInbox(path, ownUid())).toBe(true);
    expect(isInbox(path, ownUid() + 1)).toBe(false);
  });

  it("refuses a socket in a directory others may open, a symlink, a file and nothing", async () => {
    const open = join(root, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    await inbox(join(open, "2.sock"));
    expect(isInbox(join(open, "2.sock"), ownUid())).toBe(false);
    await inbox(join(socks, "3.sock"));
    symlinkSync(join(socks, "3.sock"), join(socks, "link.sock"));
    expect(isInbox(join(socks, "link.sock"), ownUid())).toBe(false);
    writeFileSync(join(socks, "file.sock"), "");
    expect(isInbox(join(socks, "file.sock"), ownUid())).toBe(false);
    expect(isInbox(join(socks, "none.sock"), ownUid())).toBe(false);
  });
});

describe("postToInbox", () => {
  it("posts one user line, as a script posts into a session", async () => {
    const path = join(socks, "4.sock");
    const lines = await inbox(path);
    const text = 'Rebase on main.\nThen say "done".';
    expect(await postToInbox(path, text)).toBe(true);
    await new Promise((done) => setTimeout(done, 20));
    expect(lines).toEqual([inboxLineOf(text)]);
    expect(JSON.parse(inboxLineOf(text))).toEqual({
      type: "user",
      message: { role: "user", content: text },
    });
  });

  it("escapes the line and paragraph separators, so the line stays one", () => {
    const line = inboxLineOf("a\u2028b\u2029c");
    expect(line).not.toMatch(/[\u2028\u2029]/u);
    expect(JSON.parse(line).message.content).toBe("a\u2028b\u2029c");
  });

  it("ignores what the inbox answers", async () => {
    const path = join(socks, "5.sock");
    await inbox(path, { answer: true });
    expect(await postToInbox(path, "hi")).toBe(true);
  });

  it("fails on an inbox no one listens on", async () => {
    expect(await postToInbox(join(socks, "6.sock"), "hi")).toBe(false);
  });

  it("gives up on an inbox that never closes, once its line went", async () => {
    const path = join(socks, "7.sock");
    const held: Socket[] = [];
    const server = createServer({ allowHalfOpen: true }, (connection) => {
      held.push(connection);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(path, done));
    const started = Date.now();
    expect(await postToInbox(path, "hi", 100)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const connection of held) connection.destroy();
  });
});
