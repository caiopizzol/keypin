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

export type Day = string & { readonly day: unique symbol };

function isDay(value: string): value is Day {
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function parseDay(value: string): Day | null {
  return isDay(value) ? value : null;
}

export function localDay(date: Date): Day {
  const pad = (n: number) => String(n).padStart(2, "0");
  return dayOf(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
}

export function addDays(day: Day, days: number): Day {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dayOf(date.toISOString().slice(0, 10));
}

function dayOf(value: string): Day {
  if (!isDay(value)) throw new Error(`"${value}" isn't a day`);
  return value;
}
