import { describe, expect, test } from "vite-plus/test";
import { judgeExpiry } from "@keypin/core";
import { day } from "@keypin/core/testing";

const NOW = new Date("2026-11-09T12:00:00Z");

describe("judgeExpiry", () => {
  test("warns under 14 days and fails under 7", () => {
    const level = (at: string) => judgeExpiry(at, NOW)?.level;
    expect(level("2026-11-23T12:00:00Z")).toBe("ok");
    expect(level("2026-11-23T11:59:59Z")).toBe("warn");
    expect(level("2026-11-16T12:00:00Z")).toBe("warn");
    expect(level("2026-11-16T11:59:59Z")).toBe("fail");
    expect(level("2026-11-01T00:00:00Z")).toBe("fail");
  });

  test("fails when it expires within 7 days of the day it's needed", () => {
    const needed = day("2026-12-18");
    expect(judgeExpiry("2026-12-24T23:00:00Z", NOW, needed)).toEqual({
      level: "fail",
      day: "2026-12-24",
      daysLeft: 45,
      neededUntil: "2026-12-25",
    });
    expect(judgeExpiry("2026-12-25T00:00:00Z", NOW, needed)?.level).toBe("ok");
  });

  test("a date it can't read gives no verdict", () => {
    expect(judgeExpiry("soon", NOW)).toBeNull();
  });
});
