import { exports } from "cloudflare:workers";
import type { Admission } from "@kelpie/access";
import type { AgentFilesContract, AgentFilesState } from "@kelpie/context-store/contract";
import { describe, expect, it, vi } from "vitest";
import { type AgentFilesDeps, handleAgentFiles, isAgentFilesPath } from "../src/agent-files.ts";

const ORIGIN = "https://ingress.test";
const owner: Admission = { admitted: true, userId: "u-owner", role: "owner", timeZone: null };
const actor = { userId: "u-owner", role: "owner", via: "webchat" };
const ROLES: Record<string, string> = {
  kelpie: "master",
  agenda: "specialist",
  "helper-1": "subagent",
  legacy: "",
};
const FILES: AgentFilesState = {
  soul: { content: "# Kelpie", version: "a".repeat(40) },
  rules: null,
  memory: null,
  skills: [],
};

function filesFake() {
  return {
    files: vi.fn<AgentFilesContract["files"]>(async () => ({ ok: true, files: FILES })),
    save: vi.fn<AgentFilesContract["save"]>(async () => ({
      ok: true,
      outcomes: [],
      commit: null,
      undo: [],
      files: FILES,
    })),
    fetchSkill: vi.fn<AgentFilesContract["fetchSkill"]>(async () => ({
      ok: false,
      reason: "not_found",
    })),
  };
}

function deps(overrides: Partial<Pick<AgentFilesDeps, "authenticate" | "admit">> = {}) {
  return {
    authenticate:
      overrides.authenticate ??
      vi.fn(async () => ({ ok: true as const, sub: "access-sub", email: "diogo@exemplo.com" })),
    admit: overrides.admit ?? vi.fn(async (): Promise<Admission> => owner),
    agentRole: vi.fn(async (id: string) => ROLES[id] ?? null),
    files: filesFake(),
  };
}

function request(
  method: string,
  path: string,
  {
    body,
    headers = {},
  }: { body?: BodyInit | undefined; headers?: Record<string, string> | undefined } = {},
) {
  const sent = new Headers({
    "Sec-Fetch-Site": "same-origin",
    ...(method === "GET" ? {} : { Origin: ORIGIN, "Content-Type": "application/json" }),
    ...headers,
  });
  for (const [name, value] of Object.entries(headers)) if (value === "") sent.delete(name);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: sent,
    ...(body === undefined ? {} : { body }),
  });
}

const read = (agent = "kelpie", headers?: Record<string, string>) =>
  request("GET", `/webchat/agents/${agent}/files`, { headers });
const save = (body: unknown, headers?: Record<string, string>) =>
  request("PUT", "/webchat/agents/kelpie/files", { body: JSON.stringify(body), headers });
const stage = (body: unknown, headers?: Record<string, string>) =>
  request("POST", "/webchat/agents/kelpie/skills/fetch", {
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    headers,
  });

describe("the editor's files routes", () => {
  it("matches only its own paths", () => {
    expect(isAgentFilesPath("/webchat/agents/kelpie/files")).toBe(true);
    expect(isAgentFilesPath("/webchat/agents/kelpie/skills/fetch")).toBe(true);
    expect(isAgentFilesPath("/webchat/agents/kelpie/files/SOUL.md")).toBe(false);
    expect(isAgentFilesPath("/webchat/agents/kelpie/mascot")).toBe(false);
  });

  it("reads an agent's files for the owner, as the actor the Directory resolved", async () => {
    const fakes = deps();
    const response = await handleAgentFiles(read(), fakes);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, files: FILES });
    expect(fakes.admit).toHaveBeenCalledWith(
      { channel: "cloudflare-access", channelUserId: "access-sub" },
      "kelpie",
    );
    expect(fakes.files.files).toHaveBeenCalledWith(actor, "kelpie");
    // An agent from before roles is listed, and served.
    expect((await handleAgentFiles(read("legacy"), deps())).status).toBe(200);
  });

  it("saves the changes the page sends, in one call", async () => {
    const fakes = deps();
    const changes = [{ file: "soul", content: "# New", version: "a".repeat(40) }];
    const response = await handleAgentFiles(save({ changes }), fakes);
    expect(response.status).toBe(200);
    expect(fakes.files.save).toHaveBeenCalledWith(actor, "kelpie", changes);
  });

  it("stages a skill from an address, pasted text, an update or an uploaded archive", async () => {
    const fakes = deps();
    const staged = { ok: true as const, staged: { id: "x" } };
    fakes.files.fetchSkill.mockResolvedValue(staged as never);
    expect((await handleAgentFiles(stage({ github: "github.com/o/r" }), fakes)).status).toBe(200);
    await handleAgentFiles(stage({ text: "---\nname: a\n---\n" }), fakes);
    await handleAgentFiles(stage({ update: "pdf" }), fakes);
    const zip = new Uint8Array([80, 75, 5, 6]);
    await handleAgentFiles(
      request("POST", "/webchat/agents/kelpie/skills/fetch?name=pdf.skill", {
        body: zip,
        headers: { "Content-Type": "application/zip" },
      }),
      fakes,
    );
    expect(fakes.files.fetchSkill.mock.calls.map((call) => call.slice(1))).toEqual([
      ["kelpie", { kind: "github", url: "github.com/o/r" }],
      ["kelpie", { kind: "text", content: "---\nname: a\n---\n" }],
      ["kelpie", { kind: "update", name: "pdf" }],
      ["kelpie", { kind: "archive", filename: "pdf.skill", bytes: zip }],
    ]);
  });

  it("answers a skill it couldn't stage with why, for the review card", async () => {
    const fakes = deps();
    fakes.files.fetchSkill.mockResolvedValue({
      ok: false,
      reason: "many_skills",
      names: ["a", "b"],
    });
    const response = await handleAgentFiles(stage({ github: "github.com/o/r" }), fakes);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, reason: "many_skills", names: ["a", "b"] });
    fakes.files.fetchSkill.mockResolvedValue({ ok: false, reason: "vault_off" });
    expect((await handleAgentFiles(stage({ github: "x" }), fakes)).status).toBe(503);
  });

  it("maps context-store's refusals to their statuses", async () => {
    for (const [reason, status] of [
      ["forbidden", 403],
      ["invalid_input", 400],
      ["vault_off", 503],
      ["unavailable", 503],
    ] as const) {
      const fakes = deps();
      fakes.files.files.mockResolvedValue({ ok: false, reason });
      const response = await handleAgentFiles(read(), fakes);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ reason });
    }
    const failing = deps();
    failing.files.save.mockRejectedValue(new Error("binding down"));
    expect((await handleAgentFiles(save({ changes: [] }), failing)).status).toBe(503);
  });

  it("refuses without a valid Access login", async () => {
    const off = deps({ authenticate: async () => ({ ok: false, reason: "not_configured" }) });
    expect((await handleAgentFiles(read(), off)).status).toBe(404);
    const expired = deps({ authenticate: async () => ({ ok: false, reason: "expired" }) });
    expect((await handleAgentFiles(read(), expired)).status).toBe(403);
    expect(expired.admit).not.toHaveBeenCalled();
  });

  it.each([
    ["a read from another site", () => read("kelpie", { "Sec-Fetch-Site": "cross-site" })],
    ["a read without fetch metadata", () => read("kelpie", { "Sec-Fetch-Site": "" })],
    ["a save from another origin", () => save({ changes: [] }, { Origin: "https://evil.test" })],
    ["a save without an origin", () => save({ changes: [] }, { Origin: "" })],
    ["a same-site save", () => save({ changes: [] }, { "Sec-Fetch-Site": "same-site" })],
    ["a stage from another origin", () => stage({ github: "x" }, { Origin: "https://evil.test" })],
  ])("refuses %s, before reading anything", async (_label, make) => {
    const fakes = deps();
    expect((await handleAgentFiles(make(), fakes)).status).toBe(403);
    expect(fakes.admit).not.toHaveBeenCalled();
    expect(fakes.agentRole).not.toHaveBeenCalled();
  });

  it("knows only listed agents that aren't subagents, and only its methods", async () => {
    for (const make of [
      () => read("nobody"),
      () => read("helper-1"),
      () => read("Not_An_Id"),
      () => request("DELETE", "/webchat/agents/kelpie/files"),
      () => request("GET", "/webchat/agents/kelpie/skills/fetch"),
      () => request("POST", "/webchat/agents/kelpie/files", { body: "{}" }),
    ]) {
      const fakes = deps();
      expect((await handleAgentFiles(make(), fakes)).status).toBe(404);
      expect(fakes.admit).not.toHaveBeenCalled();
    }
  });

  it("refuses anyone but the owner of an agent the Directory admits", async () => {
    const member = deps({
      admit: vi.fn(async (): Promise<Admission> => ({ ...owner, userId: "u-m", role: "member" })),
    });
    expect((await handleAgentFiles(read(), member)).status).toBe(403);
    expect(member.files.files).not.toHaveBeenCalled();
    const stranger = deps({
      admit: vi.fn(async (): Promise<Admission> => ({ admitted: false, reason: "no_grant" })),
    });
    expect((await handleAgentFiles(save({ changes: [] }), stranger)).status).toBe(403);
    expect(stranger.files.save).not.toHaveBeenCalled();
  });

  it("takes only the body each route expects, within its limit", async () => {
    const cases: [Request, number][] = [
      [save({ changes: [] }, { "Content-Type": "text/plain" }), 415],
      [save({ changes: [] }, { "Content-Type": "application/zip" }), 415],
      [request("PUT", "/webchat/agents/kelpie/files", { body: "{not json" }), 400],
      [save({ files: [] }), 400],
      [save([]), 400],
      [
        request("PUT", "/webchat/agents/kelpie/files", {
          body: "x",
          headers: { "Content-Length": "4500001" },
        }),
        413,
      ],
      [request("PUT", "/webchat/agents/kelpie/files", { body: "x".repeat(4_500_001) }), 413],
      [stage({ github: "x", text: "y" }), 400],
      [stage({}), 400],
      [stage({ github: 3 }), 400],
      [stage({ other: "x" }), 400],
      [stage([]), 400],
      [stage("x".repeat(2_200_001)), 413],
      [
        request("POST", "/webchat/agents/kelpie/skills/fetch", {
          body: new Uint8Array(1),
          headers: { "Content-Type": "application/octet-stream" },
        }),
        400,
      ],
      [
        request("POST", `/webchat/agents/kelpie/skills/fetch?name=${"a".repeat(201)}.zip`, {
          body: new Uint8Array(1),
          headers: { "Content-Type": "application/zip" },
        }),
        400,
      ],
      [
        request("POST", "/webchat/agents/kelpie/skills/fetch?name=a.zip", {
          body: new Uint8Array(5_000_001),
          headers: { "Content-Type": "application/zip" },
        }),
        413,
      ],
    ];
    for (const [sent, status] of cases) {
      const fakes = deps();
      expect((await handleAgentFiles(sent, fakes)).status, `${sent.method} ${sent.url}`).toBe(
        status,
      );
      expect(fakes.files.save).not.toHaveBeenCalled();
      expect(fakes.files.fetchSkill).not.toHaveBeenCalled();
    }
  });

  it("is routed in production, after Access", async () => {
    // Access isn't configured in the routing tests, so every route answers 404.
    for (const method of ["GET", "PUT", "POST"]) {
      const path =
        method === "POST"
          ? "/webchat/agents/assistant/skills/fetch"
          : "/webchat/agents/assistant/files";
      const response = await exports.default.fetch(
        request(method, path, method === "GET" ? {} : { body: "{}" }),
      );
      expect(response.status).toBe(404);
    }
  });
});
