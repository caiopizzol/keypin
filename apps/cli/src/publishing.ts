import {
  type AccountCheck,
  type Destination,
  destinationId,
  type DestinationKinds,
  type EnvEntry,
  type Environment,
  finishOperation,
  type Generation,
  kindOf,
  type ItemIds,
  type KeyEntry,
  type KeyOwner,
  type KeyRef,
  type PlanStep,
  type PublishTarget,
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
import { messageOf } from "./errors";
import { statePath } from "./paths";
import { columns, confirm, type Output } from "./output";
import { publisherFor } from "./publisher";
import { approval } from "./sign-in";

export const NEEDS_APPROVAL = 3;

export interface Checked {
  target: PublishTarget;
  destination: Destination;
  check: AccountCheck;
}

export type Say = (text: string) => void;

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
}

export function writesFor(steps: readonly PlanStep[], checked: Map<string, Checked>): Write[] {
  return steps.flatMap((step) => {
    if (step.action !== "write") return [];
    const found = checked.get(step.destinationId);
    if (!found) throw new Error(`no account check for ${step.destinationId}`);
    return [{ destinationId: step.destinationId, found }];
  });
}

export async function writeAll(input: {
  key: KeyEntry;
  environment: Environment;
  mapFile: string;
  entry: EnvEntry;
  secret: Secret;
  ids: ItemIds;
  generation: Generation;
  writes: Write[];
  state: State;
  path: string;
  deps: Deps;
  out: Output;
  label: Label;
}): Promise<{ ok: boolean; state: State }> {
  const { key, environment, mapFile, entry, secret, ids, generation, writes, path, deps, out } =
    input;
  const id = crypto.randomUUID();
  let state = startOperation(input.state, {
    id,
    keyId: key.name,
    environment,
    mapFile,
    generation,
    startedAt: deps.now().toISOString(),
    planned: writes.map((w) => w.destinationId),
  });
  await saveState(deps.files, path, state);

  for (const { destinationId: written, found } of writes) {
    const place = input.label(found.target);
    try {
      const evidence = await out.step(
        `${place}  writing ${key.name}`,
        () => found.destination.write(key.name, secret),
        () => ({ ok: true, text: `${place}  wrote ${key.name}` }),
      );
      state = recordReceipt(
        state,
        {
          keyId: key.name,
          environment,
          mapFile,
          source: entry.ref,
          sourceIds: ids,
          destinationId: written,
          generation,
          account: {
            pinned: found.target.account,
            publisher: found.check.publisher,
            destinationAccount: found.check.destinationAccount ?? found.target.account,
          },
          at: deps.now().toISOString(),
          evidence,
        },
        deps.destinations,
        id,
      );
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

export function finishAll(state: State, owner: KeyOwner): State {
  return unfinishedOperations(state, owner).reduce((s, op) => finishOperation(s, op.id), state);
}

export function withoutPlan(args: readonly string[]): string[] {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  return [...args.slice(0, end).filter((arg) => arg !== "--plan"), ...args.slice(end)];
}

export function rerun(deps: Deps, command: string, args: readonly string[]): string {
  return `To approve, run this in a terminal:\n  ${commandLine(deps, command, withoutPlan(args))}`;
}

export function commandLine(deps: Deps, command: string, args: readonly string[]): string {
  const words = [...deps.self.command, command, ...args].map(shellWord).join(" ");
  return `cd ${shellWord(deps.self.folder)} && ${words}`;
}

export function planOnly(
  deps: Deps,
  command: string,
  args: readonly string[],
  needsApproval: boolean,
): number {
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  say(
    needsApproval
      ? "\nThis plan needs approval in a terminal; --yes can't give it."
      : "\nThis plan is routine: --yes can approve it.",
  );
  say("Nothing was written: --plan only shows the plan.");
  say(rerun(deps, command, args));
  return NEEDS_APPROVAL;
}

export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
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

export function publishRows(steps: readonly PlanStep[], label: Label): PlanRow[] {
  return steps.map((step) => ({
    sign: step.action === "skip" ? "=" : step.approval ? "+" : "~",
    place: label(step.target),
    why: WHY[step.reason],
    approval: step.approval !== null,
    detail:
      step.reason === "account changed" || step.reason === "item changed" ? step.approval : null,
  }));
}

export function showRemoved(out: Output, removed: readonly RemovedDestination[]): void {
  for (const { destinationId: id, lastReceipt: last } of removed) {
    out.line(
      `  ${out.dim(`- ${id}: not in the map any more (last got ${last.generation} at ${last.at}). keypin doesn't delete it.`)}`,
    );
  }
}

export async function lookUpIds(refs: readonly KeyRef[], deps: Deps, out: Output) {
  const items = `${refs.length} item ID${refs.length === 1 ? "" : "s"}`;
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

export async function confirmed(
  deps: Deps,
  request: {
    yes: boolean;
    args: string[];
    command: string;
    needsApproval: boolean;
    question: string;
  },
  nothing = "Nothing was written.",
): Promise<boolean> {
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  if (request.yes && !request.needsApproval) return true;
  if (deps.isTerminal) {
    if (await confirm(deps, request.question)) return true;
    say(`Not confirmed. ${nothing}`);
    return false;
  }
  say(
    request.needsApproval
      ? `Stopped: this plan needs approval, and --yes can't give it. ${nothing}`
      : `Stopped: no terminal to confirm on. ${nothing} Add --yes, or confirm in a terminal.`,
  );
  say(rerun(deps, request.command, request.args));
  return false;
}
