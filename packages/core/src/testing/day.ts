import { type Day, parseDay } from "../days";

export function day(value: string): Day {
  const parsed = parseDay(value);
  if (parsed === null) throw new Error(`"${value}" isn't a day`);
  return parsed;
}
