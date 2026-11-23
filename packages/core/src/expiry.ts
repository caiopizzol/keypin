import { addDays, type Day, localDay } from "./days";

const DAY_MS = 86_400_000;
const WARN_DAYS = 14;
const FAIL_DAYS = 7;

export interface ExpiryVerdict {
  level: "ok" | "warn" | "fail";
  day: Day;
  daysLeft: number;
  neededUntil: Day | null;
}

export function judgeExpiry(
  at: string,
  now: Date,
  needed: Day | null = null,
): ExpiryVerdict | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  const day = localDay(new Date(time));
  const daysLeft = Math.floor((time - now.getTime()) / DAY_MS);
  const neededUntil = needed === null ? null : addDays(needed, FAIL_DAYS);
  const tooSoon = daysLeft < FAIL_DAYS || (neededUntil !== null && day < neededUntil);
  const level = tooSoon ? "fail" : daysLeft < WARN_DAYS ? "warn" : "ok";
  return { level, day, daysLeft, neededUntil };
}
