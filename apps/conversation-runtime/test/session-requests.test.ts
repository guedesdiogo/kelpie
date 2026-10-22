import { describe, expect, it } from "vitest";
import {
  answeredByCode,
  keepRequest,
  MAX_KEPT_REQUESTS,
  NOTICE_INPUT_CHARS,
  type OpenSessionRequest,
  parseRequestNotice,
  REQUEST_ANSWER_MS,
  REQUEST_KEY,
  requestLines,
  verdictReply,
  verdictStatus,
} from "../src/session-requests.ts";

// Approve and Deny on a VPS session's permission prompt (ADR-0069 §1, #497): what the conversation
// keeps between the notice and the owner's answer, and the fixed texts.

const NOW = Date.UTC(2026, 9, 22, 18, 0, 0);
const REQUEST_ID = "eeeeeeee-0000-4000-8000-00000000000e";

/** Draws `codes` in order, then codes of its own, each new. */
function drawer(codes: string[]) {
  let key = 0;
  let spare = 0;
  return {
    code: () => codes.shift() ?? `Z${String(spare++).padStart(5, "0")}`,
    key: () => (key++).toString(16).padStart(16, "0"),
  };
}

describe("parseRequestNotice", () => {
  it("takes a request as AgentHost passes it", () => {
    const request = { id: REQUEST_ID, tool: "Bash", input: "command: rm -rf build" };
    expect(parseRequestNotice(request)).toEqual(request);
  });

  it.each([
    ["nothing", null],
    ["an id that isn't a UUID", { id: "1", tool: "Bash", input: "x" }],
    ["a tool that isn't a name", { id: REQUEST_ID, tool: "rm -rf /", input: "x" }],
    ["an input too long", { id: REQUEST_ID, tool: "Bash", input: "i".repeat(501) }],
    ["an input that isn't text", { id: REQUEST_ID, tool: "Bash", input: 5 }],
  ])("refuses %s", (_, value) => {
    expect(parseRequestNotice(value)).toBeNull();
  });
});

describe("keepRequest", () => {
  it("opens a request with two codes and a key, for 10 minutes", () => {
    const { kept, opened } = keepRequest([], REQUEST_ID, NOW, drawer(["K7M3XW", "P4RT9C"]));
    expect(opened).toEqual({
      key: "0000000000000000",
      requestId: REQUEST_ID,
      allow: "K7M3XW",
      deny: "P4RT9C",
      expiresAt: NOW + REQUEST_ANSWER_MS,
      usedAt: null,
    });
    expect(kept).toEqual([opened]);
    expect(REQUEST_ANSWER_MS).toBe(10 * 60_000);
  });

  it("draws a code again when another kept request has it", () => {
    const first = keepRequest([], REQUEST_ID, NOW, drawer(["AAAAAA", "BBBBBB"])).kept;
    const { opened } = keepRequest(
      first,
      REQUEST_ID,
      NOW,
      drawer(["AAAAAA", "CCCCCC", "BBBBBB", "DDDDDD"]),
    );
    expect([opened.allow, opened.deny]).toEqual(["CCCCCC", "DDDDDD"]);
  });

  it("drops what is an hour past its expiry, and keeps at most 20", () => {
    const old = keepRequest([], REQUEST_ID, NOW - REQUEST_ANSWER_MS - 60 * 60_000, drawer([])).kept;
    expect(keepRequest(old, REQUEST_ID, NOW).kept).toHaveLength(1);
    let kept: OpenSessionRequest[] = [];
    for (let index = 0; index < MAX_KEPT_REQUESTS + 5; index += 1) {
      kept = keepRequest(kept, REQUEST_ID, NOW + index).kept;
    }
    expect(kept).toHaveLength(MAX_KEPT_REQUESTS);
    expect(kept[0]?.expiresAt).toBe(NOW + 5 + REQUEST_ANSWER_MS);
  });

  it("draws random codes and keys as the webchat sends them", () => {
    const { opened } = keepRequest([], REQUEST_ID, NOW);
    expect(opened.key).toMatch(REQUEST_KEY);
    expect(opened.allow).toMatch(/^[A-Z0-9]{6}$/);
    expect(opened.deny).not.toBe(opened.allow);
  });
});

describe("answeredByCode", () => {
  const kept = keepRequest([], REQUEST_ID, NOW, drawer(["K7M3XW", "P4RT9C"])).kept;

  it.each([
    ["K7M3XW", "allow"],
    ["  k7m3xw. ", "allow"],
    ["P4RT9C!", "deny"],
  ])("reads %j as the owner's %s", (text, verdict) => {
    expect(answeredByCode(kept, text)).toEqual({ request: kept[0], verdict });
  });

  it.each(["approve K7M3XW", "K7M3XW P4RT9C", "K7M3X", "ZZZZZZ", "K7M3XW\nand rebase"])(
    "reads %j as an ordinary message",
    (text) => {
      expect(answeredByCode(kept, text)).toBeNull();
    },
  );
});

describe("verdictStatus", () => {
  it.each([
    [{ ok: true, applied: true }, "applied"],
    [{ ok: true, applied: false }, "not_applied"],
    [{ ok: false, reason: "closed" }, "closed"],
    [{ ok: false, reason: "outdated" }, "failed"],
    [{ ok: false, reason: "unreachable" }, "failed"],
  ] as const)("reads %j as %s", (outcome, status) => {
    expect(verdictStatus(outcome)).toBe(status);
  });
});

describe("the notice's request lines", () => {
  const opened = keepRequest([], REQUEST_ID, NOW, drawer(["K7M3XW", "P4RT9C"])).opened;
  const request = { id: REQUEST_ID, tool: "Bash", input: 'command: echo "hi" ‮' };

  it("name the tool and its input, quoted on one line, and the codes on Telegram", () => {
    expect(requestLines(request, opened, false, "en")).toBe(
      'Tool: Bash, with "command: echo \\"hi\\"".\nTo approve it, reply with K7M3XW. To deny it, reply with P4RT9C. Or answer it in the Claude app.',
    );
    expect(requestLines(request, opened, false, "pt-BR")).toContain(
      "Para aprovar, responda K7M3XW.",
    );
    expect(requestLines(request, opened, false, "es")).toContain("Para negarlo, responde P4RT9C.");
  });

  it("point at the buttons in the webchat", () => {
    expect(requestLines(request, opened, true, "en")).toContain(
      "Approve or deny it here, or answer it in the Claude app.",
    );
    expect(requestLines(request, opened, true, "pt-BR")).not.toContain("K7M3XW");
  });

  it(`cut the input to ${NOTICE_INPUT_CHARS} characters`, () => {
    const line = requestLines({ ...request, input: "x".repeat(500) }, opened, true, "en");
    expect(line).toContain(`"${"x".repeat(NOTICE_INPUT_CHARS - 1)}…"`);
  });
});

describe("verdictReply", () => {
  it.each(["en", "pt-BR", "es"] as const)("says what came of a code, in %s", (locale) => {
    const replies = new Set(
      (["applied", "not_applied", "closed", "expired", "answered", "failed"] as const).flatMap(
        (status) => [verdictReply(status, "allow", locale), verdictReply(status, "deny", locale)],
      ),
    );
    // Approved and denied differ only when applied.
    expect(replies.size).toBe(7);
  });

  it("says approved or denied once the session took it", () => {
    expect(verdictReply("applied", "allow", "en")).toBe("Approved: the session goes on.");
    expect(verdictReply("applied", "deny", "pt-BR")).toBe("Negado: a sessão recebeu o não.");
  });
});
