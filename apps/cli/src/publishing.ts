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
import { columns, type Output } from "./output";
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

export type Label = (target: PublishTarget) => string;

export function labels(targets: readonly PublishTarget[]): Label {
  const padded = columns(targets.map(placeCells));
  const known = new Map(targets.map((target, i) => [target, padded[i]?.join("  ") ?? ""]));
  return (target) => known.get(target) ?? placeCells(target).join("  ");
}

function placeCells(target: PublishTarget): string[] {
  return target.to === "cloudflare-worker"
    ? ["Cloudflare", target.worker]
    : [
        "GitHub",
        target.environment === undefined
          ? target.repo
          : `${target.repo} environment ${target.environment}`,
      ];
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
  const publisher = await publisherFor(entry.publish, deps);
  for (const target of entry.publish) {
    const place = label(target);
    try {
      const destination = deps.destination(target, publisher);
      const check = await out.step(
        `${place}  checking the account`,
        () => destination.checkAccount(),
        (result) => ({ ok: result.ok, text: `${place}  ${out.dim(accountFacts(result))}` }),
      );
      checked.set(destinationId(target, key.name), { target, destination, check });
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

export function rerun(deps: Deps, command: string, args: readonly string[]): string {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const approve = [...args.slice(0, end).filter((arg) => arg !== "--plan"), ...args.slice(end)];
  const words = [...deps.self.command, command, ...approve].map(shellWord).join(" ");
  return `To approve, run this in a terminal:\n  cd ${shellWord(deps.self.folder)} && ${words}`;
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

export function accountFacts(check: AccountCheck): string {
  return check.ok
    ? `as ${check.publisher}, account ${check.destinationAccount ?? check.expected}`
    : `as ${check.publisher}, pinned ${check.expected}, reaches ${check.destinationAccount ?? "unknown"}`;
}
