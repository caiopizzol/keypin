import { fitKeyName } from "@keypin/core";

const NAME_LIMIT = 256;
const DAY = 86_400_000;

export interface Copy {
  limit: number | null;
  limitReset: string | null;
  includeByok: boolean;
  lifetime: number | null;
  workspaceId: string | null;
  creatorUserId: string | null;
}

export function copies(copy: Copy, remaining: number | null): string {
  const limit =
    copy.limit === null
      ? "no credit limit"
      : copy.limitReset === null
        ? `the old key's ${money(copy.limit)} limit, which never resets, starting at $0 spent${remaining === null ? "" : ` (the old key has ${money(remaining)} left)`}`
        : `the old key's ${money(copy.limit)} limit, reset ${copy.limitReset}`;
  const byok = copy.limit !== null && copy.includeByok ? ", counting BYOK usage" : "";
  const expires =
    copy.lifetime === null
      ? "no expiry"
      : `expiring ${plural(Math.ceil(copy.lifetime / DAY), "day")} after it's made`;
  const owner = copy.creatorUserId === null ? "" : ", for the same member";
  const place = copy.workspaceId === null ? "" : `, in the same workspace${owner}`;
  return `with ${limit}${byok}; ${expires}${place}`;
}

function money(usd: number): string {
  return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function fitName(name: string): string {
  return fitKeyName(name, NAME_LIMIT);
}
