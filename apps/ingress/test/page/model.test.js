import { describe, expect, it } from "vitest";
import {
  barMotion,
  clock,
  dayKey,
  dayLabel,
  elapsedText,
  fillAt,
  GROUP_GAP_MS,
  loginState,
  markOf,
  nearEnd,
  offlineText,
  pillText,
  REFILL,
  retryDelay,
  sameGroup,
  summaryText,
  waitOf,
} from "../../public/webchat/model.js";
import { localeOf, TEXTS } from "../../public/webchat/texts.js";

const T = TEXTS.en;
/** Thursday 15 October 2026, 14:32 in the browser's zone. */
const NOW = new Date(2026, 9, 15, 14, 32).getTime();
const at = (days, hours = 14, minutes = 32) =>
  new Date(2026, 9, 15 + days, hours, minutes).getTime();

describe("groups and days", () => {
  it("groups one sender's messages within 10 minutes on the same day (Telegram)", () => {
    const first = { sender: "user", at: NOW };
    expect(sameGroup(undefined, first)).toBe(false);
    expect(sameGroup(first, { sender: "user", at: NOW + GROUP_GAP_MS })).toBe(true);
    expect(sameGroup(first, { sender: "user", at: NOW + GROUP_GAP_MS + 1 })).toBe(false);
    expect(sameGroup(first, { sender: "assistant", at: NOW + 1_000 })).toBe(false);
    // Five minutes apart, but across midnight.
    const late = { sender: "user", at: at(0, 23, 58) };
    expect(sameGroup(late, { sender: "user", at: at(1, 0, 3) })).toBe(false);
  });

  it("names the day: today, yesterday, a weekday within the week, then the date", () => {
    expect(dayLabel(NOW, NOW, "en", T)).toBe("Today");
    expect(dayLabel(at(-1), NOW, "en", T)).toBe("Yesterday");
    expect(dayLabel(at(-3), NOW, "en", T)).toBe("Monday");
    expect(dayLabel(at(-3), NOW, "pt-BR", TEXTS["pt-BR"])).toBe("Segunda-feira");
    expect(dayLabel(at(-9), NOW, "en", T)).toBe("October 6");
    expect(dayLabel(new Date(2025, 11, 31).getTime(), NOW, "en", T)).toBe("December 31, 2025");
    expect(dayLabel(at(-1), NOW, "es", TEXTS.es)).toBe("Ayer");
  });

  it("writes days for <time> and times in the page's language", () => {
    expect(dayKey(NOW)).toBe("2026-10-15");
    expect(clock(NOW, "pt-BR")).toBe("14:32");
    expect(clock(NOW, "en")).toMatch(/^2:32\sPM$/);
  });
});

describe("the marks under the owner's messages", () => {
  const message = (fields) => ({
    accepted: false,
    refused: null,
    queued: false,
    slow: false,
    held: true,
    ...fields,
  });

  it("shows nothing in the first 300 ms, then 'sending', and 'held' during a wait", () => {
    expect(markOf(message({}), { waiting: false })).toBeNull();
    expect(markOf(message({ slow: true }), { waiting: false })).toBe("sending");
    expect(markOf(message({ queued: true }), { waiting: false })).toBe("queued");
    expect(markOf(message({ accepted: true }), { waiting: true })).toBe("held");
    expect(markOf(message({ accepted: true }), { waiting: false })).toBeNull();
    expect(markOf(message({ accepted: true, held: false }), { waiting: true })).toBeNull();
  });

  it("never steps back once accepted, and a refusal wins", () => {
    expect(
      markOf(message({ accepted: true, queued: true, slow: true }), { waiting: false }),
    ).toBeNull();
    expect(markOf(message({ refused: "too_long", queued: true }), { waiting: true })).toBe(
      "refused",
    );
  });
});

describe("the wait's bar (5.1)", () => {
  it("reads the deadline relative to when the frame arrived", () => {
    expect(waitOf(null, NOW)).toBeNull();
    expect(waitOf({ remainingMs: 0, spanMs: 10_000, holding: false }, NOW)).toBeNull();
    const wait = waitOf({ remainingMs: 6_000, spanMs: 10_000, holding: false }, NOW);
    expect(wait).toEqual({ until: NOW + 6_000, span: 10_000, holding: false });
    // A socket that opens in the middle draws what is left.
    expect(fillAt(wait, NOW)).toBeCloseTo(0.6);
    expect(fillAt(wait, NOW + 6_000)).toBe(0);
    expect(fillAt(wait, NOW + 9_000)).toBe(0);
    expect(fillAt(null, NOW)).toBe(0);
  });

  it("refills in the first 7% of the time, then drains linearly to the deadline", () => {
    const wait = waitOf({ remainingMs: 10_000, spanMs: 10_000, holding: false }, NOW);
    const motion = barMotion(wait, NOW, 0.2, { typing: false });
    expect(motion.duration).toBe(10_000);
    const [from, refilled, end] = motion.keyframes;
    expect(from).toEqual({ transform: "scaleX(0.2)", offset: 0 });
    expect(refilled.offset).toBe(REFILL);
    expect(Number(refilled.transform.match(/scaleX\((.+)\)/)[1])).toBeCloseTo(1 - REFILL);
    expect(end).toEqual({ transform: "scaleX(0)", offset: 1 });
  });

  it("stays full while the owner types during the hold, and is gone past the deadline", () => {
    const wait = waitOf({ remainingMs: 4_000, spanMs: 4_000, holding: true }, NOW);
    expect(barMotion(wait, NOW, 0.5, { typing: true })).toEqual({
      keyframes: [{ transform: "scaleX(0.5)" }, { transform: "scaleX(1)" }],
      duration: 4_000 * REFILL,
    });
    // Without typing, a held wait drains like any other.
    expect(barMotion(wait, NOW, 1, { typing: false }).duration).toBe(4_000);
    expect(barMotion(wait, NOW + 4_000, 1, { typing: false })).toBeNull();
  });
});

describe("following the chat (5.10)", () => {
  it("follows only within 150px of the end", () => {
    expect(nearEnd({ scrollTop: 850, clientHeight: 500, scrollHeight: 1_500 })).toBe(true);
    expect(nearEnd({ scrollTop: 849, clientHeight: 500, scrollHeight: 1_500 })).toBe(false);
  });

  it("counts what arrived below, and an approval waiting wins", () => {
    expect(pillText(T, { count: 0, approval: false })).toBeNull();
    expect(pillText(T, { count: 3, approval: false })).toBe("↓ 3 new");
    expect(pillText(T, { count: 3, approval: true })).toBe("↓ Approval waiting");
    expect(pillText(TEXTS["pt-BR"], { count: 1, approval: false })).toBe("↓ 1 nova");
  });
});

describe("a lost connection (5.12)", () => {
  it("waits with full jitter, from 300 ms up to 15 s", () => {
    expect(retryDelay(0, () => 1)).toBe(300);
    expect(retryDelay(3, () => 0.5)).toBe(1_200);
    expect(retryDelay(10, () => 1)).toBe(15_000);
  });

  it("counts down to the next try, or says 'shortly' under less motion", () => {
    expect(offlineText(T, { nextTryAt: NOW + 7_200, now: NOW, less: false })).toBe(
      "No connection. Trying again in 8 s",
    );
    expect(offlineText(T, { nextTryAt: NOW - 1, now: NOW, less: false })).toBe(
      "No connection. Trying again in 1 s",
    );
    expect(offlineText(T, { nextTryAt: NOW + 7_200, now: NOW, less: true })).toBe(
      "No connection. Trying again shortly",
    );
  });

  it("tells an expired Access login from a refused one", () => {
    expect(loginState({ type: "opaqueredirect", status: 0, ok: false })).toBe("expired");
    expect(loginState({ type: "basic", status: 401, ok: false })).toBe("expired");
    expect(loginState({ type: "basic", status: 403, ok: false })).toBe("refused");
    expect(loginState({ type: "basic", status: 200, ok: true })).toBe("ok");
    expect(loginState({ type: "basic", status: 502, ok: false })).toBe("unknown");
  });
});

describe("a turn's steps (5.2, rule 8)", () => {
  it("shows the elapsed time from 3 s, in seconds, then m:ss", () => {
    expect(elapsedText(2_999, T, { less: false })).toBeNull();
    expect(elapsedText(3_000, T, { less: false })).toBe("3 s");
    expect(elapsedText(65_000, T, { less: false })).toBe("1:05");
  });

  it("shows minutes only under less motion", () => {
    expect(elapsedText(4_000, T, { less: true })).toBe("1 min");
    expect(elapsedText(150_000, T, { less: true })).toBe("3 min");
  });

  it("sums a finished row up in one line, in each language", () => {
    expect(summaryText(3, 2_640, T)).toBe("3 steps · 2.6 s");
    expect(summaryText(1, 900, T)).toBe("1 step · 0.9 s");
    expect(summaryText(2, 2_640, TEXTS["pt-BR"])).toBe("2 etapas · 2,6 s");
    expect(summaryText(2, 2_640, TEXTS.es)).toBe("2 pasos · 2,6 s");
  });
});

describe("the page's language", () => {
  it("picks English, Brazilian Portuguese or Spanish from the browser's", () => {
    expect(localeOf("pt-PT")).toBe("pt-BR");
    expect(localeOf("es_AR")).toBe("es");
    expect(localeOf("fr")).toBe("en");
    expect(localeOf(undefined)).toBe("en");
  });

  it("writes every text in each language, with what it is given", () => {
    for (const locale of ["en", "pt-BR", "es"]) {
      const texts = TEXTS[locale];
      for (const [name, value] of Object.entries(texts)) {
        if (typeof value === "function") {
          const written = value(2, 2.5);
          expect(written, `${locale} ${name}`).toMatch(/\S/);
          expect(written, `${locale} ${name}`).not.toContain("undefined");
          if (value.length > 0) expect(value(1, 1), `${locale} ${name}`).toMatch(/\S/);
        } else if (typeof value === "object") {
          for (const text of Object.values(value)) expect(text, `${locale} ${name}`).toMatch(/\S/);
        } else {
          expect(value, `${locale} ${name}`).toMatch(/\S/);
        }
      }
      expect(texts.paused("Agenda")).toContain("Agenda");
      expect(texts.empty("Agenda")).toContain("Agenda");
      expect(texts.confirmedAt("14:32")).toContain("14:32");
      expect(texts.groupHeading("Agenda", "14:32")).toBe("Agenda, 14:32");
      expect(texts.offline(8)).toContain("8");
    }
  });

  it("has every text in all three languages", () => {
    const keys = (texts) => Object.keys(texts).sort();
    expect(keys(TEXTS["pt-BR"])).toEqual(keys(T));
    expect(keys(TEXTS.es)).toEqual(keys(T));
    for (const locale of ["en", "pt-BR", "es"]) {
      expect(Object.keys(TEXTS[locale].steps).sort()).toEqual(Object.keys(T.steps).sort());
      expect(TEXTS[locale].back(0)).not.toMatch(/\d/);
      expect(TEXTS[locale].back(2)).toContain("2");
    }
  });
});
