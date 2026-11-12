import {
  type AccountCheck,
  type Destination,
  destinationId,
  type EnvEntry,
  type Environment,
  finishOperation,
  type Generation,
  type ItemIds,
  type KeyEntry,
  type KeyOwner,
  type PlanStep,
  type PublishTarget,
  recordReceipt,
  saveState,
  type Secret,
  startOperation,
  type State,
  unfinishedOperations,
} from "@keypin/core";
import type { Deps, LockHolder } from "./deps";
import { messageOf } from "./errors";
import { statePath } from "./paths";
import { publisherFor } from "./publisher";

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

export async function checkAccounts(
  key: KeyEntry,
  entry: EnvEntry,
  deps: Deps,
  say: Say,
  heading = "Account checks",
): Promise<Map<string, Checked> | null> {
  say(`\n${heading}:`);
  const checked = new Map<string, Checked>();
  let failed = false;
  const publisher = await publisherFor(entry.publish, deps);
  for (const target of entry.publish) {
    const label = describeTarget(target, key.name);
    try {
      const destination = deps.destination(target, publisher);
      const check = await destination.checkAccount();
      checked.set(destinationId(target, key.name), { target, destination, check });
      say(
        `  ${check.ok ? "ok" : "FAILED"} ${label}: ${accountFacts(check)}${check.ok ? "" : `: ${check.reason ?? "no reason given"}`}`,
      );
      if (!check.ok) failed = true;
    } catch (error) {
      say(`  FAILED ${label}: ${messageOf(error)}`);
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
  say: Say;
}): Promise<{ ok: boolean; state: State }> {
  const { key, environment, mapFile, entry, secret, ids, generation, writes, path, deps, say } =
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
    const label = describeTarget(found.target, key.name);
    try {
      const evidence = await found.destination.write(key.name, secret);
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
        id,
      );
      await saveState(deps.files, path, state);
      say(`  wrote ${label}`);
    } catch (error) {
      say(`  FAILED ${label}: ${messageOf(error)}`);
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

export function rerun(deps: Deps, command: string, args: readonly string[]): string {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const approve = [...args.slice(0, end).filter((arg) => arg !== "--plan"), ...args.slice(end)];
  const words = [...deps.self, command, ...approve].map(shellWord).join(" ");
  return `To approve, run this in a terminal:\n  cd ${shellWord(deps.cwd)} && ${words}`;
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
      ? "\nThis plan needs yes typed in a terminal; --yes can't approve it."
      : "\nThis plan is routine: --yes can approve it.",
  );
  say("Nothing was written: --plan only shows the plan.");
  say(rerun(deps, command, args));
  return NEEDS_APPROVAL;
}

export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function accountFacts(check: AccountCheck): string {
  return `publisher ${check.publisher}, destination account ${check.destinationAccount ?? "unknown"}`;
}

export function describeTarget(target: PublishTarget, secretName: string): string {
  return `${destinationId(target, secretName)} (account ${target.account})`;
}
