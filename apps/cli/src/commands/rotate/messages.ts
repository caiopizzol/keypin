import {
  destinationId,
  formatReference,
  type Issued,
  type Issuer,
  type IssuerSpec,
  kindOf,
  placeId,
  type PlanStep,
  vaultName,
  shellWord,
} from "@keypin/core";
import { type Deps } from "../../deps";
import { commandLine, withoutPlan } from "../../approval";
import { type Checked, type PlanRow, publishRows } from "../../publishing";
import { type Pair, type Job, type Context, terminalArgs } from "./job";

export function waitsNotice(
  { deps, out, envArgs, environment }: Pick<Context, "deps" | "out" | "envArgs" | "environment">,
  keyId: string,
): void {
  const args = [keyId, ...envArgs, "--approve-revoke"];
  const local = ["keypin", "rotate", ...args].map(shellWord).join(" ");
  const warned = deps.warnRunner(
    "An old key waits for approval",
    `The old ${keyId} (${environment}) still works. Once nothing uses it, run this workflow with approve revoke, or run this in your checkout: ${local}`,
  );
  if (!warned)
    out.line(
      `Once nothing uses the old ${keyId} (${environment}), run:\n  ${commandLine(deps, "rotate", args)}`,
    );
}

export function shortLifetime(
  { key, owner }: Job,
  issuer: Issuer,
  lifetimeDays: number | undefined,
): string | null {
  const every = key.rotateEvery?.days ?? null;
  if (lifetimeDays === undefined || every === null || lifetimeDays > every) return null;
  const lasts = Math.floor(lifetimeDays);
  return `${key.name} (${owner.environment}): a new key lasts ${lasts} ${lasts === 1 ? "day" : "days"}, and rotate_every is ${key.rotateEvery?.text}, so the published key would expire before the next rotation. Give the current key a longer lifetime at ${issuer.dashboard()}, or set rotate_every under ${lasts} days in [tool.keypin.${owner.environment}.${key.name}].`;
}

export function resetStop(
  deps: Deps,
  issuer: Issuer,
  reset: Issued,
  vault: string,
  args: readonly string[],
): string {
  const when = reset.unsaved
    ? `which keypin may have saved to ${vault} on ${reset.at} (it couldn't tell), so something may use it`
    : `which keypin saved on ${reset.at} before ${vault} went back to the key it replaced, and something may still use it`;
  return `Stopped: ${issuer.describe()} makes a new key by resetting key ${shown(issuer, reset.id)}, ${when}. --yes can't approve that. To rotate anyway, run this in a terminal:\n  ${commandLine(deps, "rotate", terminalArgs(args))}\nNothing was created.`;
}

export function saveIdRow({ deps }: Job, pair: Pair): PlanRow {
  return row(
    "~",
    vaultName(pair.entry.ref, deps.vaults),
    `save its ID to ${formatReference(pair.entry.ref, deps.vaults)}, rotated today`,
  );
}

export function writeRows(job: Job, steps: PlanStep[], pairSteps: PlanStep[]): PlanRow[] {
  const { key, pair, deps } = job;
  if (!pair) return publishRows(steps, job.label, deps.destinations);
  const kinds = deps.destinations;
  const place = (step: PlanStep) => placeId(step.target, kinds);
  const both = steps.flatMap((step) => [
    { step, name: key.name },
    ...pairSteps
      .filter((p) => place(p) === place(step))
      .map((p) => ({ step: { ...p, target: step.target }, name: pair.key.name })),
  ]);
  const rows = publishRows(
    both.map((b) => b.step),
    job.label,
    kinds,
  );
  return rows.map((r, i) => ({ ...r, why: `${both[i]?.name ?? ""}: ${r.why}` }));
}

export function apartNote({ key, pair, deps, out }: Job, checked: Map<string, Checked>): void {
  if (!pair) return;
  const kinds = deps.destinations;
  const apart = pair.entry.publish.filter(
    (target) => !checked.get(destinationId(target, key.name, kinds))?.destination.writeMany,
  );
  if (!apart.length) return;
  const names = apart.map((target) => kindOf(kinds, target.to).named(target)).join(", ");
  out.line(
    `  ${out.dim(`${names} ${apart.length === 1 ? "gets" : "get"} ${key.name} and ${pair.key.name} one write after the other; a run that starts between them reads a mismatched pair. Pause new runs there until the rotation finishes.`)}`,
  );
}

export function heldSteps(job: Job, issuer: Issuer, id: string): string {
  const again = commandLine(job.deps, "rotate", withoutPlan(job.args));
  return `Once someone approves it, run this again to publish the new key and revoke the old one:\n  ${again}\nIf the change is rejected or cancelled, delete key ${shown(issuer, id)} at ${issuer.dashboard()}, then run this again.`;
}

export function reached({ entry, deps }: Job): string {
  const vault = vaultName(entry.ref, deps.vaults);
  const listed = entry.publish.length;
  if (!listed) return `the new key is in ${vault}.`;
  return `the new key is in ${vault} and the ${listed === 1 ? "destination" : `${listed} destinations`} in secretspec.toml.`;
}

export function oldStays({ out }: Job, issuer: Issuer, issued: Issued): void {
  const { old } = issued;
  if (old.id === null || old.revoked) return;
  out.line(
    out.dim(
      `\nkeypin didn't revoke key ${shown(issuer, old.id)}, the one key ${shown(issuer, issued.id)} replaced. If nothing uses it, delete it at ${issuer.dashboard()}.`,
    ),
  );
}

export function abandonedNote(
  old: Issued,
  issuer: Issuer,
  spec: IssuerSpec,
  vault: string,
): string | null {
  if (old.issuer !== spec.kind)
    return `keypin created key ${old.id} at ${old.issuer} on ${old.at}, before this key's issuer became ${issuer.describe()}. If nothing uses it, delete it at ${old.issuer}, not ${issuer.describe()}.`;
  if (!issuer.revoke) return null;
  return `keypin created key ${shown(issuer, old.id)} at ${issuer.describe()} on ${old.at}, but ${vault} doesn't hold it. If nothing uses it, delete it at ${issuer.dashboard()}.`;
}

export function revokeWhen(job: Job, interactive: string): string {
  return job.due && !job.deps.isTerminal ? "after approval" : interactive;
}

export function revokeRow(
  issuer: Issuer,
  old: string | null,
  when: string,
  detail?: string,
): PlanRow {
  return old === null
    ? row("-", issuer.describe(), "the old key stays: keypin doesn't know its ID")
    : row("-", issuer.describe(), `revoke the old key ${shown(issuer, old)}, ${when}`, detail);
}

export function shown(issuer: Issuer, id: string): string {
  return issuer.label?.(id) ?? id;
}

export function row(sign: PlanRow["sign"], place: string, why: string, detail?: string): PlanRow {
  return { sign, place, why, approval: false, detail: detail ?? null };
}
