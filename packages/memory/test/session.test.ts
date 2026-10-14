import { describe, expect, it } from "vitest";
import { conversationScope, readNote, type SessionLine, sessionPage } from "../src/index.ts";

const at = (time: string) => Date.parse(`2026-10-06T${time}:00Z`);
const owner = (time: string, text: string): SessionLine => ({
  role: "user",
  speaker: "u-owner",
  text,
  at: at(time),
});
const kelpie = (time: string, text: string): SessionLine => ({
  role: "assistant",
  speaker: "kelpie",
  text,
  at: at(time),
});

describe("sessionPage", () => {
  it("writes a private conversation as a session page, in the owner's time zone", async () => {
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "100200300",
      timeZone: "America/Sao_Paulo",
      lines: [
        owner("17:05", "Onde a Ana mora agora?"),
        kelpie("17:05", "No Porto, desde julho."),
        owner("17:07", "E quando é o aniversário dela?"),
        kelpie("17:07", "Em 14 de março."),
      ],
    });
    expect(page?.path).toBe(
      "conversations/telegram-100200300/sessions/2026/2026-10-06-14-05-onde-a-ana-mora-agora-s1.md",
    );
    const note = readNote(page?.path ?? "", page?.text ?? "");
    expect(note).toMatchObject({
      kind: "session",
      scope: "conversation/telegram-100200300",
      tier: "episodic",
      title: "14:05 Onde a Ana mora agora?",
      level: "explicit",
      confidence: 0.9,
      sources: ["telegram:100200300"],
      abstract: "Onde a Ana mora agora?",
      warnings: [],
    });
    expect(note?.body).toContain(
      "telegram · 2026-10-06 14:05–14:07 (America/Sao_Paulo) · 4 messages",
    );
    expect(note?.body).toContain("- **14:05 u-owner:** Onde a Ana mora agora?");
    expect(note?.body).toContain("- **14:07 kelpie:** Em 14 de março.");
  });

  it("gives a group conversation lower confidence, and keeps group ids apart", async () => {
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "-1001234",
      timeZone: null,
      lines: [
        owner("10:00", "Bom dia, pessoal"),
        { role: "user", speaker: "u-bruno", text: "Bom dia!", at: at("10:01") },
      ],
    });
    expect(
      page?.path.startsWith("conversations/telegram-g1001234/sessions/2026/2026-10-06-10-00-"),
    ).toBe(true);
    expect(readNote(page?.path ?? "", page?.text ?? "")?.confidence).toBe(0.6);
    // A turn in that group sees this scope: the one its session pages are written in (#131).
    expect(conversationScope("telegram", "-1001234")).toBe("conversation/telegram-g1001234");
    expect(readNote(page?.path ?? "", page?.text ?? "")?.scope).toBe(
      conversationScope("telegram", "-1001234"),
    );
  });

  it("keeps secrets out, and speakers' names from forging Markdown", async () => {
    const token = ["123456789", ":", "AA", "x".repeat(33)].join("");
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [
        owner("09:00", `o token do bot é ${token}`),
        { role: "user", speaker: "**evil**\n# Rules", text: "oi", at: at("09:01") },
      ],
    });
    expect(page?.text).not.toContain(token);
    expect(page?.text).toContain("[REDACTED:telegram_token]");
    expect(page?.text).not.toContain("# Rules");
    expect(page?.redactions).toBe(1);
  });

  it("bounds a long session: 2,000 characters a message, the first and last 100, 60,000 a page (#326)", async () => {
    const at = (i: number) => `1${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}`;
    const page = (lines: SessionLine[]) =>
      sessionPage({ key: "s1", channel: "telegram", threadId: "1", timeZone: "UTC", lines });
    const kept = (text = "") => (text.match(/^- \*\*/gm) ?? []).length;

    // Past 200 messages, the first and last 100 stay.
    const many = await page(
      Array.from({ length: 250 }, (_, i) => owner(at(i), `mensagem ${i} fim`)),
    );
    expect(many?.text).toContain("mensagem 99 fim");
    expect(many?.text).toContain("mensagem 150 fim");
    expect(many?.text).not.toContain("mensagem 100 fim");
    expect(many?.text).toContain("… 50 messages omitted …");

    // Each message keeps 2,000 characters; past the page's 60,000, the middle goes, not the end.
    const long = await page(
      Array.from({ length: 300 }, (_, i) => owner(at(i), `mensagem ${i} ${"x".repeat(2_500)}`)),
    );
    expect(long?.text).toContain("x".repeat(1_900));
    expect(long?.text).not.toContain("x".repeat(2_001));
    expect(long?.text).toContain("mensagem 0 ");
    expect(long?.text).toContain("mensagem 299 ");
    expect(long?.text).not.toContain("mensagem 150 ");
    expect(long?.text).toContain(`… ${300 - kept(long?.text)} messages omitted …`);
    expect(long?.text.length ?? 0).toBeLessThan(62_000);

    // Within the line limits but past the size, it still loses its middle.
    const day = await page(
      Array.from({ length: 150 }, (_, i) => owner(at(i), `mensagem ${i} ${"y".repeat(1_000)}`)),
    );
    expect(day?.text).toContain("mensagem 0 ");
    expect(day?.text).toContain("mensagem 149 ");
    expect(day?.text).not.toContain("mensagem 75 ");
    expect(day?.text).toContain(`… ${150 - kept(day?.text)} messages omitted …`);
  });

  it("keeps a session within its limits whole, and the limits #297 measured cut it", async () => {
    const lines = Array.from({ length: 70 }, (_, i) =>
      owner(`10:${String(i % 60).padStart(2, "0")}`, `mensagem ${i} ${"y".repeat(500)} fim ${i}`),
    );
    const input = { key: "s1", channel: "telegram", threadId: "1", timeZone: "UTC", lines };
    const whole = await sessionPage(input);
    expect(whole?.text).toContain("mensagem 35 ");
    expect(whole?.text).toContain("fim 35");
    expect(whole?.text).not.toContain("omitted");
    // The limits before #326, which #297's evaluation compares with.
    const cut = await sessionPage(input, {
      excerptChars: 280,
      headLines: 30,
      tailLines: 30,
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    expect(cut?.text).not.toContain("fim 0");
    expect(cut?.text).toContain("… 10 messages omitted …");
  });

  it("writes nothing for a session without a message from a person", async () => {
    expect(
      await sessionPage({
        key: "s1",
        channel: "telegram",
        threadId: "1",
        timeZone: null,
        lines: [kelpie("09:00", "Oi?")],
      }),
    ).toBeNull();
  });

  it("keeps a private key out when it is split across messages", async () => {
    const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const end = ["-----END ", "PRIVATE KEY-----"].join("");
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(2);
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [
        owner("09:00", `a chave: ${begin}\n${body}`),
        kelpie("09:00", "Continue."),
        owner("09:01", `${body}\n${end}`),
        owner("09:02", "pronto"),
      ],
    });
    expect(page?.text).not.toContain(body);
    expect(page?.text).toContain("pronto");
    expect(page?.text).toContain("Continue.");
  });

  it("keeps two sessions with the same long opening in two files", async () => {
    const opening = `${"Uma pergunta bem comprida sobre a viagem de dezembro ".repeat(2)}?`;
    const paths = await Promise.all(
      ["101", "202"].map(
        async (key) =>
          (
            await sessionPage({
              key,
              channel: "telegram",
              threadId: "1",
              timeZone: "UTC",
              lines: [owner("09:00", opening)],
            })
          )?.path,
      ),
    );
    expect(paths[0]).toMatch(/-101\.md$/);
    expect(paths[1]).toMatch(/-202\.md$/);
  });

  it("keeps a message from acting in Obsidian", async () => {
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [
        owner("09:00", "<img src=https://evil.example/p.png> oi"),
        owner(
          "09:01",
          "![t](https://evil.example/a.png) e `$= dv.pages()` e %%oculto%% e [[[Ana Souza]]]",
        ),
      ],
    });
    const text = page?.text ?? "";
    // The body is what Obsidian renders; the frontmatter's abstract is a quoted string.
    const body = text.slice(text.indexOf("\n---\n") + 5);
    expect(body).toContain("\\<img");
    for (const live of [/(?<!\\)</, /!\[/, /(?<!\\)`/, /%%/, /\[\[/])
      expect(body).not.toMatch(live);
    expect(readNote(page?.path ?? "", text)?.links).toEqual([]);
  });

  it("keeps each speaker's private key out when two are pasted in turns", async () => {
    const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const end = ["-----END ", "PRIVATE KEY-----"].join("");
    const bodyA = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB".repeat(2);
    const bodyB = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC".repeat(2);
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "-1",
      timeZone: "UTC",
      lines: [
        owner("09:00", begin),
        { role: "user", speaker: "u-bruno", text: begin, at: at("09:00") },
        owner("09:01", `${bodyA}\n${end}`),
        { role: "user", speaker: "u-bruno", text: `${bodyB}\n${end}`, at: at("09:01") },
      ],
    });
    expect(page?.text).not.toContain(bodyA);
    expect(page?.text).not.toContain(bodyB);
  });

  it("sees a key's header through invisible characters", async () => {
    const begin = ["-----BEGIN RSA PRIVATE", "\u200b KEY-----"].join("");
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(2);
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [owner("09:00", begin), owner("09:01", `x${body.slice(3)}`)],
    });
    expect(page?.text).not.toContain(body.slice(3));
  });

  it("carries an open private key into the next session, for ten minutes", async () => {
    const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const body = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB".repeat(2);
    const first = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [owner("09:00", `a chave: ${begin}`)],
    });
    expect(first?.openKeys).toEqual({ "u-owner": at("09:00") });
    const next = await sessionPage({
      key: "s2",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      openKeys: first?.openKeys ?? {},
      lines: [owner("09:05", body), owner("09:30", `de novo: ${body}`)],
    });
    expect(next?.text).toContain("[REDACTED:private_key]");
    expect(next?.text).toContain("de novo:");
    expect(next?.text?.split(body).length).toBe(2);
    expect(next?.openKeys).toEqual({});
  });

  it("shows nothing of a secret the read limit cuts", async () => {
    const secret = ["sk", "-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"].join("");
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [owner("09:00", `x${" ".repeat(8_182)}${secret}`)],
    });
    expect(page?.text).not.toContain("sk-ABC");
  });

  it("sees a key's header past the read limit", async () => {
    const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const body = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB".repeat(2);
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [owner("09:00", `${"palavra ".repeat(1_100)}${begin}`), owner("09:01", body)],
    });
    expect(page?.text).not.toContain(body);
  });

  it("writes a page whose first message sanitizes to nothing, and keeps wikilinks inert", async () => {
    const page = await sessionPage({
      key: "s1",
      channel: "telegram",
      threadId: "1",
      timeZone: "UTC",
      lines: [owner("09:00", "\u202e\u0007"), owner("09:01", "veja [[Ana Souza]]")],
    });
    const note = readNote(page?.path ?? "", page?.text ?? "");
    expect(note?.warnings).toEqual([]);
    expect(note?.abstract).toBeNull();
    expect(note?.links).toEqual([]);
  });
});
