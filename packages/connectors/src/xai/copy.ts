const DAY = 86_400_000;

export interface Copy {
  team: string;
  acls: string[];
  qps: number | null;
  qpm: number | null;
  tpm: string | null;
  lifetime: number | null;
}

export function copies(copy: Copy): string {
  const acls = copy.acls.length ? `ACLs ${copy.acls.join(", ")}` : "no ACLs";
  const limits = [
    ...(copy.qps === null ? [] : [`${copy.qps} requests a second`]),
    ...(copy.qpm === null ? [] : [`${copy.qpm} requests a minute`]),
    ...(copy.tpm === null ? [] : [`${copy.tpm} tokens a minute`]),
  ];
  const expires =
    copy.lifetime === null
      ? "no expiry"
      : `expiring ${plural(Math.ceil(copy.lifetime / DAY), "day")} after it's made`;
  return `with ${acls}; ${limits.length ? limits.join(", ") : "no rate limits"}; ${expires}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
