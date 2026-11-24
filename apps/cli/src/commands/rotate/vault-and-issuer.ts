import {
  formatReference,
  HeldForApproval,
  WriteRefused,
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  type ItemIds,
  type KeyRef,
  localDay,
  messageOf,
  NothingChanged,
  RevokeRefused,
  Secret,
  vaultAccounts,
  vaultName,
} from "@keypin/core";
import { type Output } from "../../output";
import { approval } from "../../sign-in";
import { commandLine, withoutPlan } from "../../approval";
import { type Pair, type Job } from "./job";
import { revokeRefused, shown } from "./messages";

export async function itemIdsAfterSave({
  entry,
  pair,
  deps,
  out,
  args,
}: Job): Promise<{ ids: ItemIds; pairIds: ItemIds | null } | null> {
  try {
    const ids = await deps.vault().itemIds(entry.ref);
    return { ids, pairIds: pair ? await deps.vault().itemIds(pair.entry.ref) : null };
  } catch (error) {
    out.line(
      `    ${messageOf(error)}\nStopped. The new key is in ${vaultName(entry.ref, deps.vaults)}, and the old key still works. To continue, run:\n  ${commandLine(deps, "rotate", args)}`,
    );
    return null;
  }
}

export async function saveId(job: Job, pair: Pair, issuer: Issuer, id: string): Promise<boolean> {
  const saved = await saveKey(job, pair.entry.ref, new Secret(id), "the new key's ID");
  if (saved === "saved") return true;
  const { deps } = job;
  job.out.line(
    `Stopped: the new key ${shown(issuer, id)} is in ${vaultName(job.entry.ref, deps.vaults)}, but its ID isn't in ${formatReference(pair.entry.ref, deps.vaults)} yet. The old key still works. Run this again to save the ID and publish both:\n  ${commandLine(deps, "rotate", withoutPlan(job.args))}`,
  );
  return false;
}

export async function revokeOrphan(
  job: Job,
  issuer: Issuer,
  id: string,
  current: Secret,
): Promise<boolean> {
  const where = issuer.describe();
  const revoke = issuer.revoke?.bind(issuer);
  if (!revoke) return true;
  try {
    await job.out.step(
      `${where}  revoking ${shown(issuer, id)}`,
      () => revoke(id, current),
      (result) => ({
        ok: true,
        text: `${where}  ${result === "revoked" ? "revoked" : "already gone:"} ${shown(issuer, id)}`,
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof RevokeRefused) {
      job.out.line(`${revokeRefused(issuer, id, error.message)} Nothing was created.`);
      return false;
    }
    job.out.line(
      `    ${messageOf(error)}\nStopped. Nothing was created. Delete key ${shown(issuer, id)} at ${issuer.dashboard()}, or run this again.`,
    );
    return false;
  }
}

export async function vaultTakesWrites({ entry, pair, deps, out }: Job): Promise<boolean> {
  try {
    await deps.vault().checkWrite?.(entry.ref);
    if (pair) await deps.vault().checkWrite?.(pair.entry.ref);
    return true;
  } catch (error) {
    out.line(`Stopped: ${messageOf(error)}. Nothing was created.`);
    return false;
  }
}

export async function issuerLists(
  issuer: Issuer,
  id: string,
  current: Secret,
  out: Output,
): Promise<boolean | null> {
  try {
    if (issuer.has) return await issuer.has(id);
    const check = await issuer.checkAccount(id, current);
    return check.ok && check.gone === undefined;
  } catch (error) {
    out.line(
      `Stopped: couldn't check key ${shown(issuer, id)} at ${issuer.describe()}: ${messageOf(error)}. Nothing was created.`,
    );
    return null;
  }
}

type Read =
  | {
      ok: true;
      secret: Secret;
      ids: ItemIds;
      admin: Secret | null;
      pair: { secret: Secret; ids: ItemIds } | null;
    }
  | { ok: false; failed: string };

export function readKeys({ entry, spec, pair, deps, out }: Job): Promise<Read> {
  const { admin: adminRef } = spec;
  const refs = [entry.ref, ...(pair ? [pair.entry.ref] : []), ...(adminRef ? [adminRef] : [])];
  const account = vaultAccounts(refs, deps.vaults);
  const what = adminRef ? "the key and the admin key" : "the key";
  return out.step(
    `Reading ${what} from ${account}`,
    async (): Promise<Read> => {
      try {
        const current = await deps.vault().readItem(entry.ref);
        const id = pair ? await deps.vault().readItem(pair.entry.ref) : null;
        const admin = adminRef ? await deps.vault().read(adminRef) : null;
        return { ok: true, ...current, admin, pair: id };
      } catch (error) {
        return { ok: false, failed: messageOf(error) };
      }
    },
    (read) => ({
      ok: read.ok,
      text: read.ok
        ? adminRef
          ? `Read the key and the admin key ${formatReference(adminRef, deps.vaults)}`
          : `Read the key ${formatReference(entry.ref, deps.vaults)}`
        : `Couldn't read from ${account}`,
    }),
    approval(deps, refs),
  );
}

export async function checkIssuer(
  issuer: Issuer,
  inVault: string | null,
  current: Secret,
  out: Output,
  admin: boolean,
): Promise<Extract<IssuerCheck, { ok: true }> | null> {
  const where = issuer.describe();
  try {
    const check = await out.step(
      `${where}  ${admin ? "checking the admin key" : "checking"}`,
      () => issuer.checkAccount(inVault, current),
      (result) => ({ ok: result.ok, text: `${where}  ${out.dim(result.facts)}` }),
    );
    if (check.ok) {
      for (const warning of check.warnings ?? []) out.warn(warning);
      return check;
    }
    out.line(`    ${check.reason}`);
    if (check.fix) out.line(`    fix: ${check.fix}`);
    return null;
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return null;
  }
}

export async function createKey(
  { map, key, owner, deps, out }: Job,
  issuer: Issuer,
): Promise<IssuedKey | { unchanged: boolean; name: string }> {
  const where = issuer.describe();
  const minute = deps.now().toISOString().slice(0, 16);
  const name = `${map.project} ${key.name} ${owner.environment} ${minute}Z ${deps.tag()}`;
  try {
    return await out.step(
      `${where}  creating ${name}`,
      () => issuer.create(name),
      (created) => ({
        ok: true,
        text: `${where}  created ${name}${created.id === name ? "" : ` (${shown(issuer, created.id)})`}`,
      }),
    );
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return { unchanged: error instanceof NothingChanged, name };
  }
}

export function mayHaveCreated({ deps, out, args }: Job, issuer: Issuer, name: string) {
  const again = commandLine(deps, "rotate", args);
  const why =
    issuer.lostCreate?.(name) ??
    `${issuer.describe()} may have made the new key before this failed. Delete any key named "${name}" at ${issuer.dashboard()} before you run this again.`;
  out.line(`Stopped: keypin didn't get the new key back. ${why}\n  ${again}`);
}

export async function undoCreate(
  job: Job,
  issuer: Issuer,
  id: string,
  current: Secret,
  stopped: string,
  forget: () => Promise<unknown> = async () => {},
): Promise<number> {
  const { out } = job;
  const where = issuer.describe();
  const unrecorded = `Stopped: ${stopped}`;
  const revoke = issuer.revoke?.bind(issuer);
  if (!revoke) {
    out.line(`${unrecorded}. The new value was never saved, so nothing changed.`);
    await forget().catch((error: unknown) =>
      out.line(`keypin couldn't update ${job.path}: ${messageOf(error)}.`),
    );
    return 1;
  }
  try {
    await out.step(
      `${where}  revoking the new key ${shown(issuer, id)}`,
      () => revoke(id, current),
      () => ({ ok: true, text: `${where}  revoked the new key ${shown(issuer, id)}` }),
    );
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    out.line(
      `${unrecorded}. keypin couldn't revoke it either: delete key ${shown(issuer, id)} at ${issuer.dashboard()}. The old key still works.`,
    );
    return 1;
  }
  out.line(`${unrecorded}. Revoked it at ${where}. Nothing changed.`);
  await forget().catch((error: unknown) =>
    out.line(
      `keypin couldn't update ${job.path}: ${messageOf(error)}. If the next run says to delete key ${shown(issuer, id)}, it's already revoked.`,
    ),
  );
  return 1;
}

export async function saveKey(
  { deps, out }: Job,
  ref: KeyRef,
  secret: Secret,
  what: string,
): Promise<"saved" | "held" | "refused" | "unknown"> {
  const place = `${vaultName(ref, deps.vaults)}  ${formatReference(ref, deps.vaults)}`;
  const today = localDay(deps.now());
  try {
    await out.step(
      `${place}  saving ${what}`,
      () => deps.vault().write(ref, secret, { rotated: today }),
      () => ({ ok: true, text: `${place}  saved, rotated ${today}` }),
      approval(deps, [ref]),
    );
    return "saved";
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    if (error instanceof HeldForApproval) return "held";
    return error instanceof WriteRefused ? "refused" : "unknown";
  }
}
