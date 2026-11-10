export const DUE_SOON_DAYS = 14;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNIT_DAYS = new Map([
  ["d", 1],
  ["w", 7],
  ["m", 30],
]);

export function periodDays(period: string | null | undefined): number | null | undefined {
  if (period === "never") return null;
  const match = /^(\d+)([dwm])$/.exec(period ?? "");
  const count = Number(match?.[1]);
  const unit = UNIT_DAYS.get(match?.[2] ?? "");
  if (!count || unit === undefined) return undefined;
  return count * unit;
}

export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
