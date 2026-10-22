import { describe, expect, it } from "vitest";
import {
  answerable,
  keepRequest,
  MAX_KEPT_REQUESTS,
  NOTICE_INPUT_CHARS,
  type OpenSessionRequest,
  parseRequestNotice,
  REQUEST_ANSWER_MS,
  requestLines,
  verdictStatus,
} from "../src/session-requests.ts";

// Approve and Deny on a VPS session's permission prompt (ADR-0069 §1, #497): the requests a
// conversation showed buttons for, until the owner's press, and the notice's fixed lines.

const NOW = Date.UTC(2026, 9, 22, 18, 0, 0);
const REQUEST_ID = "eeeeeeee-0000-4000-8000-00000000000e";
const OTHER_ID = "ffffffff-0000-4000-8000-00000000000f";

describe("parseRequestNotice", () => {
  it("takes a request as AgentHost passes it", () => {
    const request = {
      id: REQUEST_ID,
      tool: "Bash",
      input: "command: rm -rf build",
      truncated: false,
    };
    expect(parseRequestNotice(request)).toEqual(request);
  });

  it.each([
    ["nothing", null],
    ["an id that isn't a UUID", { id: "1", tool: "Bash", input: "x", truncated: false }],
    [
      "a tool that isn't a name",
      { id: REQUEST_ID, tool: "rm -rf /", input: "x", truncated: false },
    ],
    [
      "an input too long",
      { id: REQUEST_ID, tool: "Bash", input: "i".repeat(501), truncated: false },
    ],
    ["an input that isn't text", { id: REQUEST_ID, tool: "Bash", input: 5, truncated: false }],
    ["no word on whether it is cut", { id: REQUEST_ID, tool: "Bash", input: "x" }],
  ])("refuses %s", (_, value) => {
    expect(parseRequestNotice(value)).toBeNull();
  });
});

describe("keepRequest", () => {
  it("keeps a request for 10 minutes, by its id", () => {
    const { kept, opened } = keepRequest([], REQUEST_ID, NOW);
    expect(opened).toEqual({
      requestId: REQUEST_ID,
      expiresAt: NOW + REQUEST_ANSWER_MS,
      usedAt: null,
    });
    expect(kept).toEqual([opened]);
    expect(REQUEST_ANSWER_MS).toBe(10 * 60_000);
  });

  it("replaces a request of the same id, as a notice told again", () => {
    const first = keepRequest([], REQUEST_ID, NOW).kept;
    const used = first.map((request) => ({ ...request, usedAt: NOW }));
    const { kept } = keepRequest(
      [...used, ...keepRequest([], OTHER_ID, NOW).kept],
      REQUEST_ID,
      NOW + 1,
    );
    expect(kept.map((request) => [request.requestId, request.usedAt])).toEqual([
      [OTHER_ID, null],
      [REQUEST_ID, null],
    ]);
  });

  it("drops what is an hour past its expiry, and keeps at most 20", () => {
    const old = keepRequest([], OTHER_ID, NOW - REQUEST_ANSWER_MS - 60 * 60_000).kept;
    expect(keepRequest(old, REQUEST_ID, NOW).kept.map((request) => request.requestId)).toEqual([
      REQUEST_ID,
    ]);
    let kept: OpenSessionRequest[] = [];
    for (let index = 0; index < MAX_KEPT_REQUESTS + 5; index += 1) {
      const id = `eeeeeeee-0000-4000-8000-${String(index).padStart(12, "0")}`;
      kept = keepRequest(kept, id, NOW + index).kept;
    }
    expect(kept).toHaveLength(MAX_KEPT_REQUESTS);
    expect(kept[0]?.expiresAt).toBe(NOW + 5 + REQUEST_ANSWER_MS);
  });
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
  const request = {
    id: REQUEST_ID,
    tool: "Bash",
    // A right-to-left override, which the notice removes.
    input: 'command: echo "hi" \u202e',
    truncated: false,
  };

  it("name the tool and its input, quoted on one line, and point at the buttons", () => {
    expect(requestLines(request, true, "en")).toBe(
      'Tool: Bash, with "command: echo \\"hi\\"".\nApprove or deny it here, or answer it in the Claude app.',
    );
    expect(requestLines(request, true, "pt-BR")).toContain("Aprove ou negue aqui");
    expect(requestLines(request, true, "es")).toContain("Apruébalo o niégalo aquí");
  });

  it("send the owner to the Claude app where the notice has no buttons", () => {
    expect(requestLines(request, false, "en")).toBe(
      'Tool: Bash, with "command: echo \\"hi\\"".\nAnswer it in the Claude app.',
    );
    expect(requestLines(request, false, "pt-BR")).toContain("Responda no app do Claude.");
    expect(requestLines(request, false, "es")).toContain("Respóndelo en la app de Claude.");
  });

  it(`show all ${NOTICE_INPUT_CHARS} characters the runner sends`, () => {
    const line = requestLines({ ...request, input: "x".repeat(500) }, true, "en");
    expect(line).toContain(`"${"x".repeat(NOTICE_INPUT_CHARS)}"`);
  });

  it("mark an input cut short, and send the owner to the Claude app whatever the buttons", () => {
    const cut = { ...request, input: "rm -rf build", truncated: true };
    expect(answerable(cut)).toBe(false);
    expect(answerable(request)).toBe(true);
    expect(requestLines(cut, true, "en")).toBe(
      'Tool: Bash, with "rm -rf build…".\nIts input is longer than this notice shows, so answer it in the Claude app.',
    );
    expect(requestLines(cut, true, "pt-BR")).toContain("responda no app do Claude");
    expect(requestLines(cut, true, "es")).toContain("respóndelo en la app de Claude");
  });
});
