import {
  addDays,
  checkId,
  type Day,
  type DueChoice,
  type EnvEntry,
  type Expiry,
  formatReference,
  type IssuerSpec,
  judgeExpiry,
  type KeyRef,
  kindOf,
  localDay,
  messageOf,
  type PublishTarget,
  readsAdminExpiry,
  rotates,
  type VaultMetadata,
} from "@keypin/core";
import { publisherFor } from "../../publisher";
import { approval } from "../../sign-in";
import type { Context } from "./job";

type Covered = { keyId: string; entry: EnvEntry; due: Day };
type Level = "ok" | "warn" | "fail";
type Report = (level: Level, text: string, title?: string) => void;

export async function checkCredentials(
  context: Context,
  choices: readonly DueChoice[],
  dates: (ref: KeyRef) => VaultMetadata | null,
): Promise<number> {
  const covered = coveredKeys(context, choices, dates);
  const lines: { level: Level; text: string; title: string }[] = [];
  const report: Report = (level, text, title = "A credential expires soon") =>
    lines.push({ level, text, title });
  await destinationLogins(context, covered, report);
  await issuerAdmins(context, covered, report);
  const { out, deps } = context;
  if (lines.length) out.line("\nCredentials");
  for (const { level, text, title } of lines) {
    if (level === "ok") out.line(`  ${text}`);
    if (level === "fail") out.line(`${out.mark(false)} ${text}`);
    if (level === "warn" && !deps.warnRunner(title, text)) out.warn(text);
  }
  return lines.some((line) => line.level === "fail") ? 1 : 0;
}

function coveredKeys(
  { map, environment, deps }: Context,
  choices: readonly DueChoice[],
  dates: (ref: KeyRef) => VaultMetadata | null,
): Covered[] {
  const today = localDay(deps.now());
  return choices.flatMap((choice) => {
    if (choice.action === "skip" && choice.date === undefined) return [];
    const entry = rotates(map, choice.keyId, environment);
    if (!entry) return [];
    const every = map.keys.find((key) => key.name === choice.keyId)?.rotateEvery?.days ?? null;
    const rotated = dates(entry.ref)?.rotated ?? null;
    const due = every === null || rotated === null ? today : addDays(rotated, every);
    return [{ keyId: choice.keyId, entry, due: due < today ? today : due }];
  });
}

async function destinationLogins(
  { deps, environment }: Context,
  covered: readonly Covered[],
  report: Report,
): Promise<void> {
  const places = new Map<string, PublishTarget>();
  for (const { entry } of covered)
    for (const target of entry.publish) places.set(checkId(target, deps.destinations), target);
  if (!places.size) return;
  const { publisher } = await publisherFor([...places.values()], deps);
  for (const target of places.values()) {
    const where = kindOf(deps.destinations, target.to).named(target);
    try {
      const check = await deps.destination(target, publisher).checkAccount();
      if (!check.ok) {
        const fix = check.fix ? ` Fix: ${check.fix}.` : "";
        report(
          "fail",
          `${where}: ${check.reason}, so a rotation in ${environment} would stop.${fix}`,
        );
      }
      if (check.expires) loginExpiry(deps.now(), check.expires, report, where);
    } catch (error) {
      report("fail", `${where}: ${messageOf(error)}`);
    }
  }
}

async function issuerAdmins(
  { deps, environment, out }: Context,
  covered: readonly Covered[],
  report: Report,
): Promise<void> {
  for (const { keyId, entry, due } of covered) {
    const spec: IssuerSpec | undefined = entry.issuer;
    const ref = spec?.admin;
    if (!spec || !ref || !readsAdminExpiry(deps.issuers, spec)) continue;
    const name = `${keyId} (${environment})`;
    const where = formatReference(ref, deps.vaults);
    try {
      const admin = await out.step(
        `Reading the admin key ${where}`,
        () => deps.vault().read(ref),
        () => ({ ok: true, text: `Read the admin key ${where}` }),
        approval(deps, [ref]),
      );
      const expires = await deps.issuer(spec, admin).checkAdmin?.();
      if (expires) judged(deps.now(), expires, { day: due, name }, report, name);
    } catch (error) {
      report("fail", `${name}: couldn't check the issuer's admin key: ${messageOf(error)}`);
    }
  }
}

function loginExpiry(now: Date, expires: Expiry, report: Report, where: string): void {
  if (Date.parse(expires.at) > now.getTime()) return judged(now, expires, null, report, where);
  report(
    "warn",
    `${where}: keypin couldn't read when ${expires.credential} expires. The login works, but the expiry it reported (${expires.at}) isn't in the future.`,
    "A credential's expiry is unknown",
  );
}

function judged(
  now: Date,
  expires: Expiry,
  needed: { day: Day; name: string } | null,
  report: Report,
  where: string,
): void {
  const verdict = judgeExpiry(expires.at, now, needed?.day ?? null);
  if (!verdict) return;
  const left = `${verdict.daysLeft} ${verdict.daysLeft === 1 ? "day" : "days"}`;
  const when = `${expires.credential} expires ${verdict.day}, in ${left}`;
  if (verdict.level === "ok") return report("ok", `${where}: ${when}`);
  const early = needed && verdict.neededUntil !== null && verdict.day < verdict.neededUntil;
  const before = early ? `, too close to when ${needed.name} is due (${needed.day})` : "";
  report(verdict.level, `${where}: ${when}${before}. Renew it: ${expires.renew}.`);
}
