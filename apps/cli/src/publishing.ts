import {
  type AccountCheck,
  type Destination,
  destinationId,
  checkId,
  type DestinationKinds,
  type EnvEntry,
  type Environment,
  type Evidence,
  finishOperation,
  type Generation,
  kindOf,
  type ItemIds,
  type KeyEntry,
  type KeyOwner,
  type KeyRef,
  messageOf,
  type PlanStep,
  type PublishTarget,
  type Receipt,
  recordReceipt,
  type RemovedDestination,
  saveState,
  type Secret,
  startOperation,
  type State,
  unfinishedOperations,
  vaultAccounts,
} from "@keypin/core";
import type { Deps, LockHolder } from "./deps";
import { statePath } from "./paths";
import { columns, count, type Output } from "./output";
import { publisherFor } from "./publisher";
import { approval } from "./sign-in";

export interface Checked {
  target: PublishTarget;
  destination: Destination;
  check: AccountCheck;
}

export async function locked(deps: Deps, body: (path: string) => Promise<number>): Promise<number> {
  const path = statePath(deps);
  const lockFile = `${path}.lock`;
  const taken = await deps.lock(lockFile);
  if (!taken.held) {
    deps.stderr.write(`${lockedMessage(lockFile, taken.holder)}\n`);
    return 1;
  }
  try {
    return await body(path);
  } finally {
    await taken.lock.release();
  }
}

function lockedMessage(file: string, holder: LockHolder): string {
  if (holder.pid === null) {
    return `keypin: ${file} exists but names no process. If no publish is running, delete that file and try again.`;
  }
  if (holder.running === false) {
    return `keypin: ${file} was left by process ${holder.pid}, which isn't running any more. Delete that file and try again.`;
  }
  return `keypin: another publish (process ${holder.pid}) holds ${file} and is still running. Wait for it to finish.`;
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
      checked.set(destinationId(target, key.name, deps.destinations), {
        target,
        destination,
        check,
      });
      if (!check.ok) {
        failed = true;
        out.line(`    ${check.reason ?? "the account check failed"}`);
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
  operation: string;
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

function started(state: State, job: WriteJob, now: Date): State {
  if (state.operations.some((o) => o.id === job.operation)) return state;
  return startOperation(state, {
    id: job.operation,
    keyId: job.key.name,
    environment: job.environment,
    mapFile: job.mapFile,
    generation: job.generation,
    startedAt: now.toISOString(),
    planned: job.writes.map((w) => w.destinationId),
  });
}

export async function writeAll(
  job: Omit<WriteJob, "operation"> & {
    operation?: string;
    state: State;
    path: string;
    deps: Deps;
    out: Output;
    label: Label;
  },
): Promise<{ ok: boolean; state: State }> {
  const input = { ...job, operation: job.operation ?? crypto.randomUUID() };
  const { key, environment, mapFile, secret, writes, path, deps, out } = input;
  let state = started(input.state, input, deps.now());
  await saveState(deps.files, path, state);

  for (const write of writes) {
    const { found, together } = write;
    if (together?.sent) continue;
    const place = input.label(found.target);
    const members = together?.members ?? [{ job: input, write }];
    const names = members.map((m) => m.job.key.name).join(", ");
    const writeMany = found.destination.writeMany?.bind(found.destination);
    try {
      if (together) {
        state = members.reduce((s, m) => started(s, m.job, deps.now()), state);
        await saveState(deps.files, path, state);
      }
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
        state = recordReceipt(
          state,
          receiptOf(m.job, m.write, at, evidence),
          deps.destinations,
          m.job.operation,
        );
      state = { ...state, operations: state.operations.filter((o) => !allDone(o)) };
      await saveState(deps.files, path, state);
    } catch (error) {
      out.line(`    ${messageOf(error)}`);
      return { ok: false, state };
    }
  }

  state = finishAll(state, { keyId: key.name, environment, mapFile });
  await saveState(deps.files, path, state);
  return { ok: true, state };
}

const allDone = (op: { planned: string[]; done: string[] }) =>
  op.planned.every((id) => op.done.includes(id));

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
      destinationAccount: check.destinationAccount ?? target.account,
    },
    at,
    evidence,
  };
}

const BULK_LIMIT = 100;

export function writeJobs<J extends Omit<WriteJob, "operation">>(
  jobs: readonly J[],
  kinds: DestinationKinds,
): (J & { operation: string })[] {
  const withIds = jobs.map((job) => ({ ...job, operation: crypto.randomUUID() }));
  writeTogether(withIds, kinds);
  return withIds;
}

function writeTogether(jobs: readonly WriteJob[], kinds: DestinationKinds): void {
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

export function finishAll(state: State, owner: KeyOwner): State {
  return unfinishedOperations(state, owner).reduce((s, op) => finishOperation(s, op.id), state);
}

function accountFacts(check: AccountCheck): string {
  return check.ok
    ? `as ${check.publisher}, account ${check.destinationAccount ?? check.expected}`
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
  return steps.map((step) => {
    const changed =
      step.reason === "account changed" || step.reason === "item changed" ? step.approval : null;
    const note = step.action === "skip" ? null : (kindOf(kinds, step.target.to).writeNote ?? null);
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
