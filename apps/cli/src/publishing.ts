import {
  type AccountCheck,
  type Destination,
  destinationId,
  checkId,
  type DestinationKinds,
  type EnvEntry,
  type Environment,
  type Evidence,
  type Generation,
  kindOf,
  type ItemIds,
  type KeyEntry,
  type KeyRef,
  messageOf,
  type PlanStep,
  type PublishTarget,
  type Receipt,
  recordReceipt,
  type RemovedDestination,
  saveState,
  type Secret,
  type State,
  vaultAccounts,
} from "@keypin/core";
import type { Deps, LockHolder } from "./deps";
import { registryPath, statePath } from "./paths";
import { columns, count, type Output } from "./output";
import { publisherFor } from "./publisher";
import { approval } from "./sign-in";

export interface Checked {
  target: PublishTarget;
  destination: Destination;
  check: Extract<AccountCheck, { ok: true }>;
}

export async function locked(deps: Deps, body: (path: string) => Promise<number>): Promise<number> {
  const path = statePath(deps);
  const lockFile = `${path}.lock`;
  const taken = await deps.lock(lockFile);
  if (!taken.held) {
    deps.stderr.write(`keypin: ${lockedMessage(taken.holder)}\n`);
    return 1;
  }
  try {
    return await body(path);
  } finally {
    await taken.lock.release();
  }
}

export async function registryLocked<T>(
  deps: Deps,
  body: (path: string) => Promise<T>,
): Promise<T> {
  const path = registryPath(deps);
  for (let tries = 1; ; tries++) {
    const taken = await deps.lock(`${path}.lock`);
    if (taken.held) {
      try {
        return await body(path);
      } finally {
        await taken.lock.release();
      }
    }
    if (taken.holder.running !== true || tries === REGISTRY_TRIES)
      throw new Error(lockedMessage(taken.holder));
    await Bun.sleep(REGISTRY_WAIT_MS);
  }
}

const REGISTRY_TRIES = 100;
const REGISTRY_WAIT_MS = 20;

function lockedMessage({ file, pid, running }: LockHolder): string {
  if (pid === null) {
    return `${file} exists but names no process. If no keypin is running, delete that file and try again.`;
  }
  if (running === false) {
    return `${file} was left by process ${pid}, which isn't running any more. Delete that file and try again.`;
  }
  return `another keypin (process ${pid}) holds ${file} and is still running. Wait for it to finish.`;
}

export type Label = (target: PublishTarget) => string;

export function labels(targets: readonly PublishTarget[], kinds: DestinationKinds): Label {
  const cells = (target: PublishTarget) => {
    const kind = kindOf(kinds, target.to);
    return [kind.label, kind.describe(target)];
  };
  const padded = columns(targets.map(cells));
  const known = new Map(targets.map((target, i) => [target, padded[i]?.join("  ") ?? ""]));
  return (target) => known.get(target) ?? cells(target).join("  ");
}

export async function checkAccounts(
  key: KeyEntry,
  entry: EnvEntry,
  deps: Deps,
  out: Output,
  label: Label,
): Promise<Map<string, Checked> | null> {
  const checked = new Map<string, Checked>();
  let failed = false;
  const { publisher } = await publisherFor(entry.publish, deps);
  for (const target of entry.publish) {
    const place = label(target);
    try {
      const destination = deps.destination(target, publisher);
      const check = await out.step(
        `${place}  checking the account`,
        () => destination.checkAccount(),
        (result) => ({ ok: result.ok, text: `${place}  ${out.dim(accountFacts(result))}` }),
      );
      if (check.ok) {
        checked.set(destinationId(target, key.name, deps.destinations), {
          target,
          destination,
          check,
        });
      } else {
        failed = true;
        out.line(`    ${check.reason}`);
        if (check.fix) out.line(`    fix: ${check.fix}`);
      }
    } catch (error) {
      out.line(`    ${messageOf(error)}`);
      failed = true;
    }
  }
  return failed ? null : checked;
}

export interface Write {
  destinationId: string;
  found: Checked;
  together?: Together;
}

export interface WriteJob {
  key: KeyEntry;
  environment: Environment;
  mapFile: string;
  entry: EnvEntry;
  secret: Secret;
  ids: ItemIds;
  generation: Generation;
  writes: Write[];
}

interface Together {
  members: { job: WriteJob; write: Write }[];
  sent: boolean;
}

export function writesFor(steps: readonly PlanStep[], checked: Map<string, Checked>): Write[] {
  return steps.flatMap((step) => {
    if (step.action !== "write") return [];
    const found = checked.get(step.destinationId);
    if (!found) throw new Error(`no account check for ${step.destinationId}`);
    return [{ destinationId: step.destinationId, found }];
  });
}

export async function writeAll(
  job: WriteJob & {
    state: State;
    path: string;
    deps: Deps;
    out: Output;
    label: Label;
  },
): Promise<{ ok: boolean; state: State }> {
  const { key, secret, writes, path, deps, out } = job;
  let state = job.state;
  await saveState(deps.files, path, state);

  for (const write of writes) {
    const { found, together } = write;
    if (together?.sent) continue;
    const place = job.label(found.target);
    const members = together?.members ?? [{ job, write }];
    const names = members.map((m) => m.job.key.name).join(", ");
    const writeMany = found.destination.writeMany?.bind(found.destination);
    try {
      const evidence = await out.step(
        `${place}  writing ${names}`,
        () =>
          together && writeMany
            ? writeMany(members.map((m) => ({ name: m.job.key.name, secret: m.job.secret })))
            : found.destination.write(key.name, secret),
        () => ({
          ok: true,
          text: `${place}  wrote ${together ? `${names} in one version` : names}`,
        }),
      );
      if (together) together.sent = true;
      const at = deps.now().toISOString();
      for (const m of members)
        state = recordReceipt(state, receiptOf(m.job, m.write, at, evidence), deps.destinations);
      await saveState(deps.files, path, state);
    } catch (error) {
      out.line(`    ${messageOf(error)}`);
      return { ok: false, state };
    }
  }

  return { ok: true, state };
}

function receiptOf(job: WriteJob, write: Write, at: string, evidence: Evidence): Receipt {
  const { check, target } = write.found;
  return {
    keyId: job.key.name,
    environment: job.environment,
    mapFile: job.mapFile,
    source: job.entry.ref,
    sourceIds: job.ids,
    destinationId: write.destinationId,
    generation: job.generation,
    account: {
      pinned: target.account,
      publisher: check.publisher,
      destinationAccount: check.destinationAccount,
    },
    at,
    evidence,
  };
}

const BULK_LIMIT = 100;

export function writeTogether(jobs: readonly WriteJob[], kinds: DestinationKinds): void {
  const byDestination = new Map<string, Together["members"]>();
  for (const job of jobs)
    for (const write of job.writes) {
      if (!write.found.destination.writeMany) continue;
      const id = checkId(write.found.target, kinds);
      byDestination.set(id, [...(byDestination.get(id) ?? []), { job, write }]);
    }
  for (const group of byDestination.values())
    for (let i = 0; i < group.length; i += BULK_LIMIT) {
      const members = group.slice(i, i + BULK_LIMIT);
      if (members.length < 2) continue;
      const together = { members, sent: false };
      for (const { write } of members) write.together = together;
    }
}

function accountFacts(check: AccountCheck): string {
  return check.ok
    ? `as ${check.publisher}, account ${check.destinationAccount}`
    : `as ${check.publisher}, pinned ${check.expected}, reaches ${check.destinationAccount ?? "unknown"}`;
}

const WHY: Record<PlanStep["reason"], string> = {
  "no receipt": "first write",
  "new destination": "first write",
  "account changed": "account changed",
  "item changed": "vault item changed",
  "different generation": "new value",
  "receipt already has this generation": "already has this value",
};

export interface PlanRow {
  sign: "+" | "~" | "=" | "-";
  place: string;
  why: string;
  approval: boolean;
  detail: string | null;
}

export function publishRows(
  steps: readonly PlanStep[],
  label: Label,
  kinds: Deps["destinations"],
): PlanRow[] {
  const lastWrite = new Map<string, PlanStep>();
  for (const step of steps) if (step.action !== "skip") lastWrite.set(step.target.to, step);
  return steps.map((step) => {
    const changed =
      step.reason === "account changed" || step.reason === "item changed" ? step.approval : null;
    const note =
      lastWrite.get(step.target.to) === step
        ? (kindOf(kinds, step.target.to).writeNote ?? null)
        : null;
    return {
      sign: step.action === "skip" ? "=" : step.approval ? "+" : "~",
      place: label(step.target),
      why: WHY[step.reason],
      approval: step.approval !== null,
      detail: [changed, note].filter((d) => d !== null).join("; ") || null,
    };
  });
}

export function showRemoved(out: Output, removed: readonly RemovedDestination[]): void {
  for (const { destinationId: id, lastReceipt: last } of removed) {
    out.line(
      `  ${out.dim(`- ${id}: not in the map any more (last got ${last.generation} at ${last.at}). keypin doesn't delete it.`)}`,
    );
  }
}

export async function lookUpIds(refs: readonly KeyRef[], deps: Deps, out: Output) {
  const items = count(refs.length, "item ID");
  const where = vaultAccounts(refs, deps.vaults);
  return out.step(
    `Looking up ${items} in ${where}, not the values`,
    async () => {
      const ids: ItemIds[] = [];
      for (const ref of refs) ids.push(await deps.vault().itemIds(ref));
      return ids;
    },
    () => ({ ok: true, text: `Looked up ${items} in ${where}, not the values` }),
    approval(deps, refs),
  );
}

export function showPlan(out: Output, rows: readonly PlanRow[]): void {
  const cells = columns(rows.map((row) => [row.place]));
  rows.forEach((row, index) => {
    const [place = ""] = cells[index] ?? [];
    const text = `${row.sign} ${place}  ${row.why}`;
    const approval = row.approval ? `  ${out.bold("needs approval")}` : "";
    out.line(`  ${row.sign === "=" ? out.dim(text.trimEnd()) : `${text}${approval}`}`);
    if (row.detail !== null) out.line(`    ${out.dim(row.detail)}`);
  });
}
