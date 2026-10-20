import {
  derivedMascot,
  KELPIE_MASCOT,
  MASCOT_ACCESSORIES,
  MASCOT_COLORS,
  MASCOT_EYES,
  MASCOT_HEADS,
  MASCOT_SHAPES,
  type Mascot,
} from "@kelpie/config";
import { describe, expect, it } from "vitest";
import designSystem from "../../../docs/design-system.md?raw";
import styles from "../public/webchat/mascot.css?raw";
import engine from "../public/webchat/mascot.js?raw";
import {
  ACCESSORIES,
  buildMascot,
  COLORS,
  EYES,
  HEADS,
  handSpot,
  isDrawable,
  mix,
  palette,
  pointedEarOutlines,
  SHAPES,
  SHARED_DEFS,
  sizeOf,
} from "../public/webchat/mascot-art.js";
import {
  ACTIVITIES,
  APPROVED_MS,
  activityOf,
  allowed,
  available,
  BREATH,
  breathes,
  CONFIRMATION_MS,
  draw,
  due,
  effectiveMotion,
  gapAfter,
  HAND_POSES,
  HOLDING_STATES,
  IDLE,
  POSES,
  presenceAfter,
  presenceKeeper,
  REPERTOIRES,
  remember,
  SLEEP_MS,
  SPRINGS,
  WORKING_STATES,
} from "../public/webchat/mascot-states.js";

// The webchat's mascot engine (ADR-0045): its data and pure logic run here; mascot.js, which needs
// a browser, is checked by its source.

const STATES = Object.keys(POSES);

/** A presence keeper on a clock the test moves. */
function keeperWith() {
  let now = 0;
  const due: { at: number; run: () => void }[] = [];
  const timers = {
    set(run: () => void, ms: number) {
      const timer = { at: now + ms, run };
      due.push(timer);
      return timer;
    },
    clear(timer: unknown) {
      const i = due.indexOf(timer as (typeof due)[number]);
      if (i >= 0) due.splice(i, 1);
    },
  };
  const shown: { state: string }[] = [];
  const hows: { instant?: boolean; quiet?: boolean }[] = [];
  const keeper = presenceKeeper(
    (presence: { state: string }, how: { instant?: boolean; quiet?: boolean }) => {
      shown.push(presence);
      hows.push(how);
    },
    timers,
  );
  const clock = {
    advance(ms: number) {
      now += ms;
      for (const timer of [...due].sort((a, b) => a.at - b.at)) {
        if (timer.at > now || !due.includes(timer)) continue;
        due.splice(due.indexOf(timer), 1);
        timer.run();
      }
    },
  };
  return { shown, hows, keeper, clock };
}

/** A fixed sequence of random numbers, repeating. */
function sequence(...values: number[]) {
  let i = 0;
  return () => values[i++ % values.length] as number;
}

/** Mulberry32, so a long draw is the same on every run. */
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("the engine's figure", () => {
  it("draws every option @kelpie/config validates, by the same ids", () => {
    expect(Object.keys(SHAPES)).toEqual([...MASCOT_SHAPES]);
    expect(COLORS).toEqual([...MASCOT_COLORS]);
    expect(Object.keys(EYES)).toEqual([...MASCOT_EYES]);
    expect(HEADS).toEqual(MASCOT_HEADS);
    expect(ACCESSORIES).toEqual(MASCOT_ACCESSORIES);
  });

  it("has a token for every body color, the same in light and dark", () => {
    for (const color of COLORS) {
      expect(styles, color).toMatch(new RegExp(`--mascot-${color}: #[0-9a-f]{6};`));
    }
    const dark = styles.slice(styles.indexOf("prefers-color-scheme: dark"));
    expect(dark.slice(0, dark.indexOf("}\n}"))).not.toContain("--mascot-kelp");
  });

  it("builds every type and variation with no inline style, which the page's policy refuses", () => {
    const parts = (types: Record<string, readonly string[]>) =>
      Object.entries(types).flatMap(([type, variations]) =>
        variations.length === 0 ? [{ type }] : variations.map((variation) => ({ type, variation })),
      );
    const looks: Mascot[] = [
      ...MASCOT_SHAPES.map((shape) => ({ ...KELPIE_MASCOT, shape })),
      ...MASCOT_EYES.map((eyes) => ({ ...KELPIE_MASCOT, eyes, cheeks: true })),
      ...parts(MASCOT_HEADS).map((head) => ({ ...KELPIE_MASCOT, head }) as Mascot),
      ...parts(MASCOT_ACCESSORIES).map((accessory) => ({ ...KELPIE_MASCOT, accessory }) as Mascot),
    ];
    for (const look of looks) {
      for (const px of [36, 48, 160]) {
        const built = buildMascot(look, { uid: 1, px, hex: "#2e9e8e" });
        expect(built.html, JSON.stringify(look)).not.toMatch(/\sstyle=/);
        expect(built.html).toMatch(/^<svg class="mascot"[^>]* aria-hidden="true"/);
        expect(built.size).toBe(sizeOf(px));
        // The body is always a painted piece, and every piece has a box to paint it in.
        expect(built.pieces.length).toBeGreaterThan(0);
        for (const piece of built.pieces) expect(piece.box).toHaveLength(4);
      }
    }
    expect(SHARED_DEFS).not.toMatch(/\sstyle=/);
  });

  it("is sized for the roster, the header and a profile", () => {
    expect([sizeOf(36), sizeOf(48), sizeOf(160)]).toEqual(["s", "m", "l"]);
    const roster = buildMascot(KELPIE_MASCOT, { uid: 2, px: 36, hex: "#2e9e8e" });
    const header = buildMascot(KELPIE_MASCOT, { uid: 3, px: 48, hex: "#2e9e8e" });
    // At 36 px: a badge with the tool's icon, no mittens and no task objects.
    expect(roster.html).toContain('class="bd-ico"');
    expect(roster.html).not.toContain('class="hand ');
    expect(roster.html).not.toContain('class="m-work"');
    // At 48 px: the 3D bubble, the mittens and the objects.
    expect(header.html).toContain("bub3d");
    expect(header.html).toContain('class="hand hand-l"');
    expect(header.html).toContain("act-search");
  });

  it("hides what sits in the middle of the head under a hat", () => {
    const hat = { type: "hat", variation: "top" } as const;
    for (const [head, mark] of [
      [{ type: "horns", variation: "one" }, 'class="horn"'],
      [{ type: "horns", variation: "antennae" }, 'class="m-ant"'],
      [{ type: "hair", variation: "curl" }, 'class="m-leaf"'],
      [{ type: "leaves", variation: "kelp" }, 'class="m-leaf"'],
    ] as const) {
      const look = { ...KELPIE_MASCOT, head };
      expect(buildMascot(look, { uid: 4, px: 48, hex: "#2e9e8e" }).html).toContain(mark);
      const hatted = buildMascot({ ...look, accessory: hat }, { uid: 4, px: 48, hex: "#2e9e8e" });
      expect(hatted.html, head.variation).not.toContain(mark);
    }
    // Ears and two horns sit at the sides, so they stay.
    for (const head of [KELPIE_MASCOT.head, { type: "horns", variation: "two" }] as const) {
      const built = buildMascot(
        { ...KELPIE_MASCOT, head, accessory: hat },
        { uid: 5, px: 48, hex: "#2e9e8e" },
      );
      expect(built.html).toMatch(/class="(m-ear|horn)"/);
    }
  });

  it("draws the pointed ear as a kelpie's, with a light shell, inside the frame on every shape (#455)", () => {
    const points = (d: string) =>
      Array.from(
        d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g),
        ([, x, y]) => [Number(x), Number(y)] as const,
      );
    const channels = (hex: string) =>
      [1, 3, 5].reduce((sum, i) => sum + Number.parseInt(hex.slice(i, i + 2), 16), 0);
    for (const shape of MASCOT_SHAPES) {
      const built = buildMascot(
        { ...KELPIE_MASCOT, shape, head: { type: "ears", variation: "pointed" } },
        { uid: 6, px: 160, hex: "#2e9e8e" },
      );
      const ears = Array.from(
        built.html.matchAll(
          /translate\(([\d.]+) ([\d.]+)\) translate\(0 -2\.8\) rotate\((-?[\d.]+)\)"><g class="m-ear"><g class="fp" data-piece="(\d+)"/g,
        ),
        ([, x, y, a, index]) => ({
          x: Number(x),
          y: Number(y),
          a: Number(a),
          piece: built.pieces[Number(index)],
        }),
      );
      expect(ears, shape).toHaveLength(2);
      // The listening mitten goes to the ear the shape shows.
      expect(built.anchors.ear, shape).toEqual([ears[1]?.x, ears[1]?.y, ears[1]?.a]);
      const [left = [], right] = ears.map(({ piece }) => points(piece.shapes[0].d));
      // The right ear mirrors the left (0 - x, so the top's 0 stays 0 and not -0).
      expect(right, shape).toEqual(left.map(([x, y]) => [0 - x, y]));
      const outlines = pointedEarOutlines(shape);
      ears.forEach(({ x, y, a, piece }, i) => {
        const [ear, shell] = piece.shapes;
        expect(channels(shell.fill), shape).toBeGreaterThan(channels(ear.fill));
        // Every point, control points included, stays in the frame (viewBox 10 14 100 100), with room for the fur.
        const r = (a * Math.PI) / 180;
        const placed = points(ear.d).map(([px, py]) => {
          const fx = x + px * Math.cos(r) - py * Math.sin(r);
          const fy = y - 2.8 + px * Math.sin(r) + py * Math.cos(r);
          expect(fy, `${shape} ${px},${py}`).toBeGreaterThan(15);
          expect(fx, `${shape} ${px},${py}`).toBeGreaterThan(11);
          expect(fx, `${shape} ${px},${py}`).toBeLessThan(109);
          return [fx, fy];
        });
        // The outline the logo takes (ADR-0062) is the ear the mascot draws, point for point.
        const outline = points(outlines[i] ?? "");
        expect(outline, shape).toHaveLength(placed.length);
        outline.forEach(([ox, oy], j) => {
          expect(ox).toBeCloseTo(placed[j]?.[0] ?? Number.NaN, 2);
          expect(oy).toBeCloseTo(placed[j]?.[1] ?? Number.NaN, 2);
        });
      });
    }
  });

  it("draws only a mascot it knows, so a bad frame never reaches the markup", () => {
    expect(isDrawable(KELPIE_MASCOT)).toBe(true);
    expect(isDrawable({ ...KELPIE_MASCOT, head: { type: "none" } })).toBe(true);
    for (const bad of [
      null,
      "mark",
      { ...KELPIE_MASCOT, shape: "__proto__" },
      { ...KELPIE_MASCOT, shape: "toString" },
      { ...KELPIE_MASCOT, color: "ink" },
      { ...KELPIE_MASCOT, eyes: "constructor" },
      { ...KELPIE_MASCOT, cheeks: "yes" },
      { ...KELPIE_MASCOT, head: { type: "__proto__" } },
      { ...KELPIE_MASCOT, head: { type: "ears", variation: "mohawk" } },
      { ...KELPIE_MASCOT, head: { type: "none", variation: "pointed" } },
      { ...KELPIE_MASCOT, accessory: { type: "hat" } },
      { ...KELPIE_MASCOT, accessory: null },
    ]) {
      expect(isDrawable(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("shades the body from its token, with no amber", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(palette("#2E9E8E")).toMatchObject({ body: "#2e9e8e" });
    expect(palette("#2e9e8e").light).not.toBe(palette("#2e9e8e").dark);
  });

  it("places the mittens on the 120 grid", () => {
    const anchors = { fx: 60, fy: 70, spread: 14, tx: 60, ty: 36, ear: null };
    expect(handSpot("dockL", anchors)).toEqual([38, 90, 25, 0.3]);
    expect(handSpot("ear", { ...anchors, ear: [79, 45] })).toEqual([88, 54, -35, 1.4]);
    expect(handSpot("nowhere", anchors)).toBeNull();
    for (const hands of Object.values(HAND_POSES)) {
      for (const spot of Object.values(hands)) expect(handSpot(spot, anchors)).not.toBeNull();
    }
  });
});

describe("poses per state (ADR-0045 §6)", () => {
  it("gives every state a pose that reads when still, and a breath", () => {
    expect(STATES).toEqual([
      "idle",
      "dozing",
      "listening",
      "typing",
      "working",
      "waiting",
      "approved",
      "error",
      "noResponse",
      "offline",
    ]);
    for (const state of STATES) expect(BREATH, state).toHaveProperty(state);
  });

  it("matches the decision's table", () => {
    expect(POSES.idle).toMatchObject({ eyes: "open", brows: "none", badge: "none" });
    expect(POSES.dozing).toMatchObject({ eyes: "closed", fx: "zzz" });
    expect(POSES.listening.tilt).not.toBe(0);
    expect(POSES.typing).toMatchObject({ mouth: "o" });
    expect(POSES.waiting).toMatchObject({ brows: "up", badge: "wait" });
    expect(POSES.waiting.eye).toBeGreaterThan(1);
    expect(POSES.approved).toMatchObject({ eyes: "happy", mouth: "smile" });
    expect(POSES.error).toMatchObject({ brows: "worry", badge: "error" });
    // Amber and red ride on the bubble's glyph and shape too, never on color alone.
    expect(SHARED_DEFS).toContain('id="kg-wait"');
    expect(engine).toContain('{ wait: "?", error: "!", silent: "…" }');
  });

  it("keeps the hands of listening, typing, approved, error and dozing, as reduced motion shows them", () => {
    expect(HAND_POSES).toEqual({
      listening: { r: "ear" },
      typing: { l: "typeL", r: "typeR" },
      approved: { l: "thumbL", r: "thumbR" },
      error: { l: "cheekL", r: "cheekR" },
      dozing: { r: "pillowR" },
    });
    // At work, the mittens come with the task's object; offline, with its plug (ADR-0047).
    expect([...WORKING_STATES]).toEqual(["working", "noResponse"]);
    expect([...HOLDING_STATES]).toEqual(["working", "noResponse", "offline"]);
  });

  it("shows only a real activity: a tool without its own object shows thinking", () => {
    expect(Object.keys(ACTIVITIES)).toEqual([
      "search",
      "vault",
      "code",
      "calendar",
      "email",
      "think",
      "plug",
    ]);
    expect(activityOf("vault")).toBe("vault");
    // The plug is Offline's, never a tool's.
    expect(activityOf("plug")).toBe("think");
    expect(activityOf(undefined)).toBe("think");
    expect(activityOf("teleport")).toBe("think");
    expect(activityOf("toString")).toBe("think");
  });
});

describe("the repertoire's draw", () => {
  it("never draws one of the last two gestures", () => {
    const random = seededRandom(7);
    for (const state of Object.keys(REPERTOIRES)) {
      const options = available(state, "header", { ears: 2, sinceHop: 60_000, sinceWake: 60_000 });
      if (options.length < 3) continue;
      let recent: string[] = [];
      for (let i = 0; i < 500; i++) {
        const name = draw(options, recent, random) as string;
        expect(recent, `${state} drew ${name}`).not.toContain(name);
        recent = remember(recent, name);
      }
    }
  });

  it("alternates between two gestures, and plays a lone one", () => {
    const typing = available("typing", "header", { ears: 0, sinceHop: 0, sinceWake: 0 });
    expect(typing.map((option: { name: string }) => option.name)).toEqual(["talk", "blink"]);
    let recent: string[] = [];
    const drawn: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = draw(typing, recent, seededRandom(i)) as string;
      drawn.push(name);
      recent = remember(recent, name);
    }
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]).not.toBe(drawn[i - 1]);
    expect(draw([{ name: "nod", weight: 1 }], ["nod", "blink"], Math.random)).toBe("nod");
    expect(draw([], [], Math.random)).toBeNull();
  });

  it("draws by weight", () => {
    const options = [
      { name: "often", weight: 3 },
      { name: "rarely", weight: 1 },
      { name: "never", weight: 0 },
    ];
    expect(draw(options, [], sequence(0))).toBe("often");
    expect(draw(options, [], sequence(0.74))).toBe("often");
    expect(draw(options, [], sequence(0.76))).toBe("rarely");
    expect(draw(options, [], sequence(0.999_999))).toBe("rarely");
  });

  it("keeps the roster's gestures, the ear's need for ears, and the hop's rest", () => {
    const names = (state: string, mode: string, figure: object) =>
      available(state, mode, { ears: 0, sinceHop: 0, sinceWake: 0, ...figure }).map(
        (option: { name: string }) => option.name,
      );
    expect(names("idle", "header", {})).not.toContain("hop");
    expect(names("idle", "header", {})).not.toContain("ear");
    expect(names("idle", "header", { sinceHop: 12_001, ears: 2 })).toEqual(
      expect.arrayContaining(["hop", "doubleHop", "ear"]),
    );
    // A roster row never hops (ADR-0045 §4).
    expect(names("idle", "list", { sinceHop: 60_000, ears: 2 })).toEqual([
      "blink",
      "glance",
      "ear",
    ]);
    expect(names("dozing", "header", {})).toEqual(["snore", "stir"]);
    expect(names("dozing", "header", { sinceWake: 20_001 })).toContain("wakeBored");
    expect(names("approved", "header", {})).toEqual([]);
    expect(names("noResponse", "header", {})).toEqual([]);
    expect(names("unknown", "header", {})).toEqual([]);
  });

  it("rests longer between gestures in a roster row than in the header (ADR-0045 §4)", () => {
    expect(gapAfter("idle", "header", sequence(0))).toBe(2500);
    expect(gapAfter("idle", "list", sequence(0))).toBe(5500);
    expect(gapAfter("idle", "list", sequence(1))).toBeCloseTo(13_200);
    expect(gapAfter("approved", "large", sequence(0))).toBeCloseTo(2125);
  });

  it("has a method in the engine for every gesture it can draw", () => {
    const gestures = new Set(
      Object.values(REPERTOIRES).flatMap((options) => options.map((o) => o.name)),
    );
    for (const name of gestures) expect(engine, name).toMatch(new RegExp(`\\n  ${name}\\(`));
  });
});

describe("the scheduler's guards", () => {
  const mascot = {
    state: "idle",
    mode: "header",
    visible: true,
    quietable: true,
    lastEvent: 0,
    nextGesture: 1_000,
  };
  const world = { now: 2_000, hidden: false, motion: "alive", quietUntil: 0, listLock: 0 };

  it("draws a gesture once the rest is over", () => {
    expect(due(mascot, world)).toBe("gesture");
    expect(due(mascot, { ...world, now: 500 })).toBe("rest");
  });

  it("does nothing in a hidden tab or off screen", () => {
    expect(due(mascot, { ...world, hidden: true })).toBe("rest");
    expect(due({ ...mascot, visible: false }, world)).toBe("rest");
    expect(breathes(mascot, { ...world, hidden: true })).toBe(false);
    expect(breathes({ ...mascot, visible: false }, world)).toBe(false);
    expect(breathes(mascot, world)).toBe(true);
  });

  it("follows the pause: States only and Still draw nothing and don't breathe", () => {
    for (const motion of ["states", "still"]) {
      expect(due(mascot, { ...world, motion })).toBe("rest");
      expect(breathes(mascot, { ...world, motion })).toBe(false);
    }
    expect(due({ ...mascot, mode: "still" }, world)).toBe("rest");
  });

  it("means Still under reduced motion, whatever the setting", () => {
    expect(effectiveMotion("alive", true)).toBe("still");
    expect(effectiveMotion("states", true)).toBe("still");
    expect(effectiveMotion("states", false)).toBe("states");
    expect(effectiveMotion(null, false)).toBe("alive");
  });

  it("only blinks while the owner types", () => {
    expect(due(mascot, { ...world, quietUntil: 2_500 })).toBe("blink");
    // A roster row isn't the conversation's mascot.
    expect(due({ ...mascot, quietable: false }, { ...world, quietUntil: 2_500 })).toBe("gesture");
  });

  it("dozes after 45 s without an event, only when idle", () => {
    const late = { ...world, now: SLEEP_MS + 1 };
    expect(due(mascot, late)).toBe("doze");
    expect(due({ ...mascot, state: "working" }, late)).toBe("gesture");
    expect(due(mascot, { ...late, motion: "states" })).toBe("rest");
  });

  it("gives a roster one gesture at a time", () => {
    expect(due({ ...mascot, mode: "list" }, { ...world, listLock: 2_500 })).toBe("defer");
    expect(due({ ...mascot, mode: "list" }, { ...world, listLock: 1_500 })).toBe("gesture");
  });
});

describe("the pause's announcements", () => {
  it("plays everything in Alive and nothing in Still", () => {
    const loop = { duration: 300, iterations: Number.POSITIVE_INFINITY };
    expect(allowed(loop, "alive")).toBe(loop);
    expect(allowed(loop, "still")).toBeNull();
  });

  it("ends every announcement within 5 s in States only", () => {
    expect(allowed({ duration: 300, iterations: Number.POSITIVE_INFINITY }, "states")).toEqual({
      duration: 300,
      iterations: 16,
    });
    expect(allowed({ duration: 380, iterations: 11, delay: 1_000 }, "states")).toEqual({
      duration: 380,
      iterations: 10,
      delay: 1_000,
    });
    expect(allowed({ duration: 500 }, "states")).toEqual({ duration: 500, iterations: 1 });
    expect(allowed({ duration: 560, delay: 4_700 }, "states")).toBeNull();
    for (const timing of [
      { duration: 2_400, iterations: Number.POSITIVE_INFINITY, delay: 200 },
      { duration: 1_600, iterations: 3, delay: 150 },
    ]) {
      const fit = allowed(timing, "states");
      expect((fit?.delay ?? 0) + (fit?.duration ?? 0) * (fit?.iterations ?? 0)).toBeLessThanOrEqual(
        5_000,
      );
    }
  });

  it("plays the design system's springs", () => {
    for (const [name, token] of [
      ["fast", "--spring-fast"],
      ["base", "--spring-base"],
      ["slow", "--spring-slow"],
      ["moment", "--spring-moment"],
      ["pop", "--spring-pop"],
    ] as const) {
      expect(designSystem).toContain(`${token}: ${SPRINGS[name].easing};`);
      expect(designSystem).toContain(`${token}-dur: ${SPRINGS[name].duration}ms;`);
    }
  });
});

describe("how a change shows (§4.1, 5.3)", () => {
  it("passes a keyboard's change on to show at once", () => {
    const { hows, keeper } = keeperWith();
    keeper.event({ type: "bubble", text: "No model answered.", failed: true });
    // The owner's message, sent with Enter, ends the error.
    keeper.event({ type: "sent" }, { instant: true });
    expect(hows).toEqual([
      { instant: false, quiet: false },
      { instant: true, quiet: false },
    ]);
  });

  it("brings no announcement for an expiry or a refused press", () => {
    const { shown, hows, keeper, clock } = keeperWith();
    keeper.event({ type: "bubble", text: "Confirm?", confirmation: 1 });
    clock.advance(CONFIRMATION_MS);
    expect(shown.at(-1)?.state).toBe("idle");
    expect(hows.at(-1)).toEqual({ quiet: true });
    keeper.event({ type: "bubble", text: "Confirm?", confirmation: 2 });
    keeper.event({ type: "confirmation", id: 2, status: "refused" });
    expect(hows.at(-1)).toEqual({ instant: false, quiet: true });
    // A confirm still announces its Approved.
    keeper.event({ type: "bubble", text: "Confirm?", confirmation: 3 });
    keeper.event({ type: "confirmation", id: 3, status: "accepted" });
    expect(shown.at(-1)?.state).toBe("approved");
    expect(hows.at(-1)).toEqual({ instant: false, quiet: false });
  });

  it("waits only as long as an open confirmation has left, after a reconnect", () => {
    const { shown, keeper, clock } = keeperWith();
    keeper.event({ type: "history" });
    const open = { id: 7, summary: "Create the event.", askedAgoMs: 570_000, expiresInMs: 30_000 };
    keeper.event({ type: "requests", requests: [open], more: 0 });
    expect(shown.at(-1)?.state).toBe("waiting");
    clock.advance(29_999);
    expect(shown.at(-1)?.state).toBe("waiting");
    clock.advance(1);
    expect(shown.at(-1)?.state).toBe("idle");
  });

  it("moves a quiet mascot to its pose without the announcement", () => {
    expect(engine).toContain("if (!quiet) this.announce(next);");
  });
});

describe("Offline, when the page loses its connection (ADR-0047)", () => {
  const working = presenceAfter(IDLE, { type: "status", status: "thinking" });
  const offline = presenceAfter(working, { type: "offline" });

  it("holds the plug that came out, looking at it, beside a grey bubble", () => {
    expect(POSES.offline).toMatchObject({ brows: "up", badge: "offline" });
    expect(POSES.offline.gaze).toEqual(ACTIVITIES.plug.gaze);
    expect(styles).toContain('.mascot[data-act="plug"] .act-plug');
    expect(styles).toContain('.mascot[data-badge="offline"] .bd-c');
    expect(SHARED_DEFS).toContain('id="kg-off"');
    expect(buildMascot(KELPIE_MASCOT, { uid: 1, px: 160, hex: "#2e9e8e" }).html).toContain(
      "act-plug",
    );
  });

  it("is calm: it never hops, and rests 4 to 8 s between gestures", () => {
    const names = REPERTOIRES.offline.map((gesture: { name: string }) => gesture.name);
    expect(names).toEqual([
      "blink",
      "glance",
      "lookAtPlug",
      "tryPlug",
      "shakePlug",
      "lookAround",
      "sigh",
      "yawn",
    ]);
    for (const at of [0, 0.5, 0.999]) {
      const gap = gapAfter("offline", "header", () => at);
      expect(gap).toBeGreaterThanOrEqual(4_000);
      expect(gap).toBeLessThanOrEqual(8_000);
    }
  });

  it("comes only when the banner enters, not when the socket closes", () => {
    // The page can't vouch for the turn, but Offline waits for the banner's 2 s (5.12).
    expect(presenceAfter(working, { type: "closed" })).toBe(working);
    expect(offline).toEqual({ state: "offline", activity: null, tool: false });
  });

  it("leaves with the history, whatever it held", () => {
    expect(presenceAfter(offline, { type: "history" })).toEqual(IDLE);
    expect(presenceAfter(offline, { type: "status", status: "thinking" })).toEqual(working);
  });

  it("returns to Waiting after a reconnect while a confirmation is still open (5.12)", () => {
    const back = presenceAfter(offline, { type: "history" });
    const open = { id: 7, summary: "Create the event.", askedAgoMs: 1, expiresInMs: 600_000 };
    expect(presenceAfter(back, { type: "requests", requests: [open], more: 0 })).toEqual({
      state: "waiting",
      activity: null,
      tool: false,
    });
    // A turn at work keeps showing its work; an answered request ends the wait.
    expect(presenceAfter(working, { type: "requests", requests: [open], more: 0 })).toBe(working);
    const waiting = presenceAfter(back, { type: "requests", requests: [open], more: 0 });
    expect(presenceAfter(waiting, { type: "requests", requests: [], more: 0 })).toEqual(IDLE);
    expect(presenceAfter(working, { type: "requests", requests: [], more: 0 })).toBe(working);
  });

  it("drops the plug and swings it on arrival, and clicks it home with a small hop", () => {
    expect(engine).toContain('if (state === "offline") {');
    expect(engine).toContain('if (previous === "offline") {');
    expect(engine).toContain("this.hop(8);");
  });
});

describe("the mascot's state from the conversation", () => {
  const working = presenceAfter(IDLE, { type: "status", status: "thinking" });

  it("works with the tool's real activity, and thinks between tools", () => {
    expect(working).toEqual({ state: "working", activity: "think", tool: false });
    expect(presenceAfter(IDLE, { type: "status", status: "memory" })).toMatchObject({
      state: "working",
      activity: "vault",
    });
    expect(presenceAfter(working, { type: "status", status: "tool", activity: "search" })).toEqual({
      state: "working",
      activity: "search",
      tool: true,
    });
    // A tool without an object of its own shows thinking, never one that isn't in use.
    expect(presenceAfter(working, { type: "status", status: "tool" })).toMatchObject({
      activity: "think",
    });
    expect(presenceAfter(working, { type: "status", status: "idle" })).toEqual(IDLE);
    expect(presenceAfter(working, { type: "status", status: "surprise" })).toBe(working);
  });

  it("types while the reply is written, unless a tool runs", () => {
    const typing = presenceAfter(working, { type: "typing", active: true });
    expect(typing).toMatchObject({ state: "typing" });
    const tool = presenceAfter(working, { type: "status", status: "tool", activity: "vault" });
    expect(presenceAfter(tool, { type: "typing", active: true })).toBe(tool);
    expect(presenceAfter(typing, { type: "typing", active: false })).toEqual(IDLE);
    expect(presenceAfter(working, { type: "typing", active: false })).toBe(working);
  });

  it("waits for the owner on a confirmation's notice, and approves their yes", () => {
    const waiting = presenceAfter(working, { type: "bubble", confirmation: 7 });
    expect(waiting).toMatchObject({ state: "waiting" });
    expect(presenceAfter(waiting, { type: "confirmation", status: "accepted" })).toMatchObject({
      state: "approved",
    });
    expect(presenceAfter(waiting, { type: "confirmation", status: "refused" })).toEqual(IDLE);
    expect(presenceAfter(waiting, { type: "sent" })).toEqual(IDLE);
  });

  it("shows an error for the notice of a turn no route answered, until the next message", () => {
    const error = presenceAfter(working, { type: "bubble", failed: true });
    expect(error).toMatchObject({ state: "error" });
    // The failed turn settles right after its notice, and that clears only the step.
    expect(presenceAfter(error, { type: "status", status: "idle" })).toBe(error);
    expect(presenceAfter(error, { type: "sent" })).toEqual(IDLE);
    expect(presenceAfter(error, { type: "status", status: "thinking" })).toMatchObject({
      state: "working",
    });
  });

  it("keeps waiting when the turn that asked settles", () => {
    const waiting = presenceAfter(working, { type: "bubble", confirmation: 7 });
    expect(presenceAfter(waiting, { type: "status", status: "idle" })).toBe(waiting);
  });

  it("is idle after a reply, a pause or a new socket, and never listens without the bar", () => {
    expect(presenceAfter(working, { type: "bubble" })).toEqual(IDLE);
    expect(presenceAfter(working, { type: "paused" })).toEqual(IDLE);
    expect(presenceAfter(working, { type: "history" })).toEqual(IDLE);
    expect(presenceAfter(working, { type: "sent" })).toBe(working);
    expect(presenceAfter(IDLE, { type: "sent" }).state).not.toBe("listening");
    expect(presenceAfter(IDLE, { type: "unknown" })).toBe(IDLE);
  });

  it("listens during the wait its bar shows (ADR-0045 §5), unless work has taken over", () => {
    const wait = { type: "wait", deadline: { remainingMs: 8_000, spanMs: 10_000, holding: false } };
    const listening = presenceAfter(IDLE, wait);
    expect(listening).toEqual({ state: "listening", activity: null, tool: false });
    expect(presenceAfter(listening, { type: "wait", deadline: null })).toEqual(IDLE);
    expect(presenceAfter(working, wait)).toBe(working);
    const typing = presenceAfter(working, { type: "typing", active: true });
    expect(presenceAfter(typing, wait)).toBe(typing);
    // The end of a wait it never listened to changes nothing.
    expect(presenceAfter(working, { type: "wait", deadline: null })).toBe(working);
    expect(presenceAfter(IDLE, { type: "wait", deadline: { remainingMs: 0 } })).toBe(IDLE);
  });

  it("shows the approval for 1.1 s, then what arrived meanwhile", () => {
    const { shown, keeper, clock } = keeperWith();
    keeper.event({ type: "bubble", confirmation: 3 });
    keeper.event({ type: "confirmation", status: "accepted" });
    keeper.event({ type: "status", status: "thinking" });
    expect(shown.at(-1)).toMatchObject({ state: "approved" });
    clock.advance(APPROVED_MS);
    expect(shown.map((presence) => presence.state)).toEqual(["waiting", "approved", "working"]);
    // Nothing waiting: back to idle.
    keeper.event({ type: "bubble", confirmation: 4 });
    keeper.event({ type: "confirmation", status: "accepted" });
    clock.advance(APPROVED_MS);
    expect(shown.at(-1)).toEqual(IDLE);
  });

  it("stops waiting when the confirmation expires, after 10 minutes", () => {
    const { shown, keeper, clock } = keeperWith();
    keeper.event({ type: "bubble", confirmation: 3 });
    clock.advance(CONFIRMATION_MS - 1);
    expect(keeper.current.state).toBe("waiting");
    clock.advance(1);
    expect(shown.at(-1)).toEqual(IDLE);
  });

  it("waits for the latest notice: each confirmation has its own 10 minutes", () => {
    const { keeper, clock } = keeperWith();
    keeper.event({ type: "bubble", confirmation: 3 });
    clock.advance(8 * 60_000);
    keeper.event({ type: "bubble", confirmation: 4 });
    clock.advance(2 * 60_000);
    expect(keeper.current.state).toBe("waiting");
    clock.advance(8 * 60_000);
    expect(keeper.current.state).toBe("idle");
  });

  it("shows a change only, so a reconnect doesn't wake a dozing mascot", () => {
    const { shown, keeper } = keeperWith();
    keeper.event({ type: "history" });
    keeper.event({ type: "status", status: "idle" });
    expect(shown).toEqual([]);
    keeper.event({ type: "status", status: "thinking" });
    keeper.event({ type: "status", status: "thinking" });
    expect(shown).toHaveLength(1);
  });

  it("names the agents' defaults by the same ids", () => {
    // The derived defaults draw only options the engine knows.
    for (const id of ["setup", "agenda", "sales-bot"]) {
      const look = derivedMascot(id);
      expect(Object.keys(SHAPES)).toContain(look.shape);
      expect(COLORS).toContain(look.color);
    }
  });
});
