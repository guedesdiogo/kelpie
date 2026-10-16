import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { KELPIE_MASCOT, type Mascot } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretStore } from "../src/index.ts";
import { drawPhotos, MODULES, type PhotoBrowser, photoPage } from "../src/photo/draw.ts";
import engine from "../src/photo/webchat/mascot.js.txt";

// The agent's mascot as its Telegram bot's photo (ADR-0046). Browser Run is a stand-in here: tests
// give a BotPhoto one through its `env` and run its alarm themselves.

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw-test";
const STILL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const LOOP = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const OTHER: Mascot = { ...KELPIE_MASCOT, color: "lagoon" };

/** Text in HTML, as Browser Run returns it. */
const html = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A stand-in for Browser Run that answers every page with `answer`, or fails with `status`. */
function browser(answer: unknown = { still: base64(STILL), loop: base64(LOOP) }, status = 200) {
  const asked: { action: string; options: Record<string, unknown> }[] = [];
  const stand: PhotoBrowser & { asked: typeof asked } = {
    asked,
    async quickAction(action, options) {
      asked.push({ action, options: options as Record<string, unknown> });
      if (status !== 200) {
        return Response.json({ success: false, errors: [{ code: 6002 }] }, { status });
      }
      return Response.json({
        success: true,
        result: `<html><body data-done="1"><pre id="photo">${html(JSON.stringify(answer))}</pre></body></html>`,
      });
    },
  };
  return stand;
}

interface Upload {
  method: string;
  photo?: Record<string, unknown>;
  file?: { type: string; bytes: number[] };
}

/** A fake Bot API. `photo` answers each `setMyProfilePhoto` by the photo's type. */
function botApi(
  photo: (type: string) => Response = () => Response.json({ ok: true, result: true }),
) {
  const calls: Upload[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = input.split("/").at(-1) ?? "";
    if (method === "getMe") {
      return Response.json({ ok: true, result: { id: 123456789, username: "kelpie_bot" } });
    }
    if (method !== "setMyProfilePhoto" || !(init?.body instanceof FormData)) {
      return Response.json({ ok: true, result: true });
    }
    const form = init.body;
    const file = form.get("file") as File;
    const upload = {
      method,
      photo: JSON.parse(String(form.get("photo"))),
      file: { type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] },
    };
    calls.push(upload);
    return photo(String(upload.photo.type));
  });
  return calls;
}

async function connect(agentId: string) {
  const form = await exports.ChannelForms.createTelegramForm(agentId);
  if (!form.ok) throw new Error("form refused");
  await exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN);
}

const photoOf = (agentId: string) => env.BOT_PHOTO.getByName(agentId);

/**
 * Runs the agent's BotPhoto alarm now, with `stand` as its browser. The alarm it set is taken off,
 * so the runtime doesn't run it too.
 */
function drawNow(agentId: string, stand: PhotoBrowser) {
  return runInDurableObject(photoOf(agentId), async (instance, state) => {
    const configurable = instance as unknown as { env: Env };
    configurable.env = { ...configurable.env, BROWSER: stand as unknown as BrowserRun };
    await state.storage.deleteAlarm();
    await instance.alarm();
  });
}

const stored = (agentId: string) =>
  runInDurableObject(photoOf(agentId), async (_instance, state) => ({
    wanted: await state.storage.get<{ mascot: Mascot }>("wanted"),
    alarm: await state.storage.getAlarm(),
  }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("The photo page", () => {
  it("runs the webchat's own modules on the mascot, and no text closes its scripts", () => {
    const page = photoPage(KELPIE_MASCOT);
    expect(page.match(/<\/script>/g)).toHaveLength(2);
    // It reaches nothing outside itself.
    expect(page).toContain(`http-equiv="Content-Security-Policy" content="default-src 'none';`);
    expect(page).toContain(JSON.stringify(KELPIE_MASCOT));
    const modules = JSON.parse(
      /<script type="application\/json" id="modules">([^<]*)<\/script>/.exec(page)?.[1] ?? "{}",
    );
    expect(Object.keys(modules)).toEqual(MODULES.map(([name]) => name));
    expect(modules["mascot.js"]).toBe(engine);
  });

  it("loads each module after the ones it imports, which the page points at by blob URL", () => {
    const seen = new Set<string>();
    for (const [name, text] of MODULES) {
      const imports = [...text.matchAll(/from "\.\/([\w-]+\.js)"/g)].map((found) => found[1]);
      expect(
        imports.filter((dependency) => !seen.has(dependency ?? "")),
        name,
      ).toEqual([]);
      // The page rewrites only `from "./…"`: no other import may reach a relative file.
      expect(text, name).not.toMatch(/import\s*\(|^import\s+["']/m);
      seen.add(name);
    }
  });
});

describe("Drawing a photo", () => {
  it("answers with the still and the loop the page drew", async () => {
    const stand = browser();
    const photos = await drawPhotos(stand, KELPIE_MASCOT);
    expect(photos).toEqual({ still: STILL, loop: LOOP });
    expect(stand.asked).toHaveLength(1);
    expect(stand.asked[0]?.action).toBe("content");
    expect(stand.asked[0]?.options).toMatchObject({
      viewport: { width: 800, height: 800 },
      waitForSelector: { selector: "body[data-done]" },
    });
    expect(String(stand.asked[0]?.options.html)).toContain(JSON.stringify(KELPIE_MASCOT));
  });

  it("goes without the loop when the page has none, or it isn't an MP4", async () => {
    for (const loop of [null, base64(STILL), "not base64!", base64(new Uint8Array([0, 0, 0]))]) {
      const photos = await drawPhotos(browser({ still: base64(STILL), loop }), KELPIE_MASCOT);
      expect(photos).toEqual({ still: STILL, loop: null });
    }
  });

  it("fails when the page does, so the photo is tried again", async () => {
    await expect(drawPhotos(browser({}, 422), KELPIE_MASCOT)).rejects.toThrow(/422/);
    await expect(
      drawPhotos(browser({ error: "no <canvas> & no luck" }), KELPIE_MASCOT),
    ).rejects.toThrow("The photo page failed: no <canvas> & no luck");
    await expect(drawPhotos(browser({ loop: base64(LOOP) }), KELPIE_MASCOT)).rejects.toThrow(
      /no still/,
    );
    await expect(
      drawPhotos(browser({ still: base64(LOOP), loop: base64(LOOP) }), KELPIE_MASCOT),
    ).rejects.toThrow(/no still/);
    const page = (result: string): PhotoBrowser => ({
      quickAction: async () => Response.json({ success: true, result }),
    });
    await expect(drawPhotos(page("<html></html>"), KELPIE_MASCOT)).rejects.toThrow(/no answer/);
    await expect(
      drawPhotos(page('<pre id="photo">{not json</pre>'), KELPIE_MASCOT),
    ).rejects.toThrow(/isn't JSON/);
    const broken: PhotoBrowser = { quickAction: async () => new Response("oops") };
    await expect(drawPhotos(broken, KELPIE_MASCOT)).rejects.toThrow(/answered 200/);
    await expect(drawPhotos(page("x".repeat(41 * 1024 * 1024)), KELPIE_MASCOT)).rejects.toThrow(
      /too much/,
    );
  });
});

describe("Asking for a bot's photo", () => {
  it("takes a known agent and a whole mascot only", async () => {
    for (const [agentId, mascot] of [
      ["Not An Agent", KELPIE_MASCOT],
      ["photo-a", { ...KELPIE_MASCOT, color: "plaid" }],
      ["photo-a", null],
    ] as const) {
      expect(await exports.ChannelEgress.updateBotPhoto(agentId, mascot)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
  });

  it("asks nothing for an agent without a bot", async () => {
    expect(await exports.ChannelEgress.updateBotPhoto("photo-none", KELPIE_MASCOT)).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect((await stored("photo-none")).wanted).toBeUndefined();
  });

  it("keeps the newest mascot, and draws it a few seconds later", async () => {
    botApi();
    await connect("photo-b");
    const before = Date.now();
    expect(await exports.ChannelEgress.updateBotPhoto("photo-b", KELPIE_MASCOT)).toEqual({
      ok: true,
    });
    expect(await exports.ChannelEgress.updateBotPhoto("photo-b", OTHER)).toEqual({ ok: true });
    const { wanted, alarm } = await stored("photo-b");
    expect(wanted?.mascot).toEqual(OTHER);
    expect(alarm).toBeGreaterThanOrEqual(before + 4_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("answers a store that fails as unavailable", async () => {
    vi.spyOn(SecretStore.prototype, "read").mockResolvedValue({
      ok: false,
      reason: "store_unavailable",
    });
    expect(await exports.ChannelEgress.updateBotPhoto("photo-c", KELPIE_MASCOT)).toEqual({
      ok: false,
      reason: "store_unavailable",
    });
  });
});

describe("A bot's photo", () => {
  it("sends the loop, with its first frame as the still, once per mascot and bot", async () => {
    const uploads = botApi();
    await connect("photo-d");
    const stand = browser();
    await exports.ChannelEgress.updateBotPhoto("photo-d", KELPIE_MASCOT);
    await drawNow("photo-d", stand);
    expect(uploads).toEqual([
      {
        method: "setMyProfilePhoto",
        photo: { type: "animated", animation: "attach://file", main_frame_timestamp: 0 },
        file: { type: "video/mp4", bytes: [...LOOP] },
      },
    ]);
    expect((await stored("photo-d")).wanted).toBeUndefined();

    // The same mascot again, as when the bot connects again, isn't drawn or sent.
    await exports.ChannelEgress.updateBotPhoto("photo-d", KELPIE_MASCOT);
    await drawNow("photo-d", stand);
    expect(stand.asked).toHaveLength(1);
    expect(uploads).toHaveLength(1);

    await exports.ChannelEgress.updateBotPhoto("photo-d", OTHER);
    await drawNow("photo-d", stand);
    expect(stand.asked).toHaveLength(2);
    expect(uploads).toHaveLength(2);
  });

  it("sends the still when there is no loop, or Telegram refuses it", async () => {
    const refused = botApi((type) =>
      type === "animated"
        ? Response.json({ ok: false, error_code: 400, description: "nope" }, { status: 400 })
        : Response.json({ ok: true, result: true }),
    );
    await connect("photo-e");
    await exports.ChannelEgress.updateBotPhoto("photo-e", KELPIE_MASCOT);
    await drawNow("photo-e", browser());
    expect(refused.map(({ photo }) => photo?.type)).toEqual(["animated", "static"]);
    expect(refused[1]?.file).toEqual({ type: "image/jpeg", bytes: [...STILL] });

    await exports.ChannelEgress.updateBotPhoto("photo-e", OTHER);
    await drawNow("photo-e", browser({ still: base64(STILL), loop: null }));
    expect(refused.map(({ photo }) => photo?.type)).toEqual(["animated", "static", "static"]);

    // A loop too large for Telegram (413) leaves the still too.
    const large = botApi((type) =>
      type === "animated"
        ? Response.json({ ok: false, error_code: 413 }, { status: 413 })
        : Response.json({ ok: true, result: true }),
    );
    await exports.ChannelEgress.updateBotPhoto("photo-e", KELPIE_MASCOT);
    await drawNow("photo-e", browser());
    expect(large.map(({ photo }) => photo?.type)).toEqual(["animated", "static"]);
  });

  it("waits as long as Telegram asks, 30 s at least, and gives up after 5 tries", async () => {
    let answer: { status: number; retry_after?: number } = { status: 429, retry_after: 60 };
    botApi(() =>
      Response.json(
        { ok: false, error_code: answer.status, parameters: { retry_after: answer.retry_after } },
        { status: answer.status },
      ),
    );
    await connect("photo-f");
    await exports.ChannelEgress.updateBotPhoto("photo-f", KELPIE_MASCOT);
    let before = Date.now();
    await drawNow("photo-f", browser());
    let now = await stored("photo-f");
    expect(now.wanted?.mascot).toEqual(KELPIE_MASCOT);
    expect(now.alarm).toBeGreaterThanOrEqual(before + 60_000);
    // A 429 without `retry_after` reads as 1 s, and waits 30 s.
    answer = { status: 429 };
    before = Date.now();
    await drawNow("photo-f", browser());
    expect((await stored("photo-f")).alarm).toBeGreaterThanOrEqual(before + 30_000);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    answer = { status: 500 };
    await expect(drawNow("photo-f", browser())).rejects.toThrow();
    await expect(drawNow("photo-f", browser({}, 422))).rejects.toThrow(/422/);
    expect((await stored("photo-f")).wanted?.mascot).toEqual(KELPIE_MASCOT);
    // The fifth try is the last: the mascot is given up, without throwing.
    await drawNow("photo-f", browser());
    now = await stored("photo-f");
    expect(now.wanted).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(
      "channel-egress: a bot's photo was given up",
      "ChannelRequestError",
    );
  });

  it("gives up at once when Telegram refuses the bot for good", async () => {
    const uploads = botApi(() =>
      Response.json({ ok: false, error_code: 401, description: "nope" }, { status: 401 }),
    );
    await connect("photo-i");
    await exports.ChannelEgress.updateBotPhoto("photo-i", KELPIE_MASCOT);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await drawNow("photo-i", browser());
    expect(uploads).toHaveLength(1);
    expect((await stored("photo-i")).wanted).toBeUndefined();
  });

  it("draws one agent's photo 5 minutes apart at least", async () => {
    botApi();
    await connect("photo-j");
    await exports.ChannelEgress.updateBotPhoto("photo-j", KELPIE_MASCOT);
    const drawnAt = Date.now();
    await drawNow("photo-j", browser());
    await exports.ChannelEgress.updateBotPhoto("photo-j", OTHER);
    const { alarm } = await stored("photo-j");
    expect(alarm).toBeGreaterThanOrEqual(drawnAt + 5 * 60_000);
  });

  it("tries again when the secret store fails, and drops a bot disconnected meanwhile", async () => {
    const uploads = botApi();
    await connect("photo-g");
    await exports.ChannelEgress.updateBotPhoto("photo-g", KELPIE_MASCOT);
    const read = vi.spyOn(SecretStore.prototype, "read").mockResolvedValue({
      ok: false,
      reason: "store_unavailable",
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(drawNow("photo-g", browser())).rejects.toThrow(/secret store/);
    expect((await stored("photo-g")).wanted?.mascot).toEqual(KELPIE_MASCOT);

    read.mockResolvedValue({ ok: false, reason: "missing" });
    const stand = browser();
    await drawNow("photo-g", stand);
    expect(stand.asked).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect((await stored("photo-g")).wanted).toBeUndefined();
  });

  it("gives a mascot asked for while another is drawn its own turn", async () => {
    const uploads = botApi();
    await connect("photo-h");
    await exports.ChannelEgress.updateBotPhoto("photo-h", KELPIE_MASCOT);
    const stand = browser();
    const draw = stand.quickAction.bind(stand);
    stand.quickAction = async (action, options) => {
      await exports.ChannelEgress.updateBotPhoto("photo-h", OTHER);
      return draw(action, options);
    };
    await drawNow("photo-h", stand);
    expect(uploads).toHaveLength(1);
    const { wanted, alarm } = await stored("photo-h");
    expect(wanted?.mascot).toEqual(OTHER);
    expect(alarm).not.toBeNull();
    // An alarm with nothing to draw does nothing.
    await runInDurableObject(photoOf("photo-h"), (_instance, state) =>
      state.storage.delete("wanted"),
    );
    await drawNow("photo-h", stand);
    expect(uploads).toHaveLength(1);
  });
});
