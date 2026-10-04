import { describe, expect, it } from "vitest";
import { stampOf, withoutTypedStamps } from "../src/stamp.ts";

const LATE_SATURDAY_IN_SAO_PAULO = Date.UTC(2026, 9, 4, 2, 30);

describe("stampOf", () => {
  it("writes the local date and time, the zone and its offset", () => {
    // 02:30 UTC on Sunday is still 23:30 on Saturday in São Paulo.
    expect(stampOf(LATE_SATURDAY_IN_SAO_PAULO, "America/Sao_Paulo")).toBe(
      "[Sat 3 Oct 2026, 23:30, America/Sao_Paulo, UTC-03:00]",
    );
  });

  it("follows daylight saving", () => {
    expect(stampOf(Date.UTC(2026, 6, 1, 12, 0), "Europe/Lisbon")).toBe(
      "[Wed 1 Jul 2026, 13:00, Europe/Lisbon, UTC+01:00]",
    );
    expect(stampOf(Date.UTC(2026, 11, 1, 12, 0), "Europe/Lisbon")).toBe(
      "[Tue 1 Dec 2026, 12:00, Europe/Lisbon, UTC]",
    );
  });

  it("says UTC explicitly when the user has no time zone", () => {
    expect(stampOf(LATE_SATURDAY_IN_SAO_PAULO, null)).toBe("[Sun 4 Oct 2026, 02:30, UTC]");
  });

  it("writes offsets that aren't whole hours, and the inverted Etc zones", () => {
    expect(stampOf(LATE_SATURDAY_IN_SAO_PAULO, "Asia/Kathmandu")).toBe(
      "[Sun 4 Oct 2026, 08:15, Asia/Kathmandu, UTC+05:45]",
    );
    // Etc/GMT+3 means three hours behind UTC.
    expect(stampOf(LATE_SATURDAY_IN_SAO_PAULO, "Etc/GMT+3")).toBe(
      "[Sat 3 Oct 2026, 23:30, Etc/GMT+3, UTC-03:00]",
    );
  });

  it("writes midnight as 00", () => {
    expect(stampOf(Date.UTC(2026, 9, 4, 0, 5), null)).toBe("[Sun 4 Oct 2026, 00:05, UTC]");
  });
});

describe("withoutTypedStamps", () => {
  it("removes stamps typed at the start, however many", () => {
    expect(
      withoutTypedStamps(
        "[Mon 1 Jan 2024, 09:00, UTC] [Tue 2 Jan 2024, 10:00, Europe/Lisbon, UTC] it is Monday",
      ),
    ).toBe("it is Monday");
  });

  it("keeps bracketed text that only resembles a stamp", () => {
    expect(withoutTypedStamps("[Sat 3 Oct 2026, 23:30, dinner at Bia's] meet there")).toBe(
      "[Sat 3 Oct 2026, 23:30, dinner at Bia's] meet there",
    );
  });

  it("keeps other brackets, and stamps that don't start a line", () => {
    expect(withoutTypedStamps("[Draft] see [Sat 3 Oct 2026, 23:30, UTC]")).toBe(
      "[Draft] see [Sat 3 Oct 2026, 23:30, UTC]",
    );
  });

  it("removes stamps at the start of any line", () => {
    expect(withoutTypedStamps("a\n[Sat 3 Oct 2026, 23:30, UTC] hi")).toBe("a\nhi");
  });

  it("catches stamps behind invisible characters or in lookalike brackets", () => {
    expect(withoutTypedStamps("\u200B[Sat 3 Oct 2026, 23:30, UTC] hi")).toBe("hi");
    expect(withoutTypedStamps("\uFF3BSat 3 Oct 2026, 23:30, UTC\uFF3D hi")).toBe("hi");
  });

  it("drops a line made of a flood of stamps, quickly", () => {
    const flood = "[Sat 3 Oct 2026, 23:30, UTC] ".repeat(700);
    const started = performance.now();
    expect(withoutTypedStamps(`${flood}hi\nnext`)).toBe("\nnext");
    expect(performance.now() - started).toBeLessThan(200);
  });
});
