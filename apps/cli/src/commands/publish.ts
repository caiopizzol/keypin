import { parseArgs } from "node:util";
import {
  approvalsFor,
  type AccountCheck,
  type Destination,
  destinationId,
  type Environment,
  ENVIRONMENTS,
  type KeysMap,
  finishOperation,
  generationOf,
  loadState,
  planPublish,
  type PublishTarget,
  recordReceipt,
  saveState,
  type Secret,
  startOperation,
  type State,
  unfinishedOperations,
} from "@keypin/core";
import { type Deps, type LockHolder, UsageError } from "../deps";
import { messageOf } from "../errors";
import { statePath } from "../paths";
import { findMap } from "../project";
import { announce } from "../vault";

export const NEEDS_APPROVAL = 2;

interface Checked {
  target: PublishTarget;
  destination: Destination;
  check: AccountCheck;
}

export async function publish(args: string[], deps: Deps): Promise<number> {
  const request = parseRequest(args);
  const map = await findMap(deps.files, deps.cwd);
  const path = statePath(deps);
  const lockFile = `${path}.lock`;
  const taken = await deps.lock(lockFile);
  if (!taken.held) {
    deps.stderr.write(`${lockedMessage(lockFile, taken.holder)}\n`);
    return 1;
  }
  try {
    return await publishLocked({ ...request, args }, map, path, deps);
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

function parseRequest(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      env: { type: "string", default: "prod" },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [keyId, ...extra] = positionals;
  if (keyId === undefined || extra.length) throw new UsageError("keypin publish takes one key ID");
  const environment = ENVIRONMENTS.find((name) => name === values.env);
  if (!environment) {
    throw new UsageError(`--env is ${ENVIRONMENTS.join(" or ")}, got "${values.env}"`);
  }
  return { keyId, environment, yes: values.yes };
}

async function publishLocked(
  request: { keyId: string; environment: Environment; yes: boolean; args: string[] },
  map: KeysMap,
  path: string,
  deps: Deps,
): Promise<number> {
  const { keyId, environment } = request;
  const key = map.keys.find((k) => k.id === keyId);
  if (!key) throw new Error(`${map.file} has no key "${keyId}"`);
  const entry = key.environments[environment];
  if (!entry) throw new Error(`key "${keyId}" has no ${environment} entry in ${map.file}`);

  const say = (text: string) => deps.stderr.write(`${text}\n`);
  say(`Publishing ${keyId} (${environment}) as ${key.env}, from item "${entry.ref.item}"`);
  say(`  vault: 1Password account ${entry.ref.account}, vault "${entry.ref.vault}"`);
  for (const target of entry.publish) say(`  to: ${describeTarget(target, key.env)}`);
  if (!entry.publish.length) {
    say(`The map lists no destinations for ${keyId} (${environment}); nothing to publish.`);
    return 1;
  }

  let state = await loadState(deps.files, path);
  for (const op of unfinishedOperations(state, keyId, environment)) {
    say(
      `An earlier publish (started ${op.startedAt}, generation ${op.generation}) didn't finish: wrote ${op.done.length} of ${op.planned.length} (${op.done.join(", ") || "none"}). This run plans again from the receipts.`,
    );
  }

  say("\nAccount checks:");
  const checked = new Map<string, Checked>();
  let failed = false;
  for (const target of entry.publish) {
    const label = describeTarget(target, key.env);
    try {
      const destination = deps.destination(target);
      const check = await destination.checkAccount();
      checked.set(destinationId(target, key.env), { target, destination, check });
      say(
        `  ${check.ok ? "ok" : "FAILED"} ${label}: ${accountFacts(check)}${check.ok ? "" : `: ${check.reason ?? "no reason given"}`}`,
      );
      if (!check.ok) failed = true;
    } catch (error) {
      say(`  FAILED ${label}: ${messageOf(error)}`);
      failed = true;
    }
  }
  if (failed) {
    say("Stopped: an account check failed. Nothing was read and nothing was written.");
    return 1;
  }

  const approvals = approvalsFor({ key, environment, receipts: state.receipts });
  if (approvals.length && !deps.isTerminal) {
    say("\nNeeds approval:");
    for (const approval of approvals) say(`  ${approval.approval}`);
    say(
      `Stopped before reading the value: this publish needs approval, and --yes can't give it. Nothing was read and nothing was written.`,
    );
    say(rerun(deps, request.args));
    return NEEDS_APPROVAL;
  }

  announce(deps.stderr, "the value to publish", [entry.ref]);
  let secret: Secret;
  try {
    secret = await deps.vault().read(entry.ref);
  } catch (error) {
    say(`Stopped: couldn't read ${keyId} (item "${entry.ref.item}"): ${messageOf(error)}`);
    return 1;
  }
  const generation = await generationOf(secret);
  const plan = planPublish({ key, environment, receipts: state.receipts, generation });

  say(`\nPlan for generation ${generation}:`);
  const writes: { destinationId: string; found: Checked }[] = [];
  for (const step of plan.steps) {
    const found = checked.get(step.destinationId);
    if (!found) throw new Error(`no account check for ${step.destinationId}`);
    say(`  ${step.action} ${describeTarget(step.target, key.env)}: ${step.reason}`);
    say(`    ${accountFacts(found.check)}`);
    if (step.approval) say(`    needs approval: ${step.approval}`);
    if (step.action === "write") writes.push({ destinationId: step.destinationId, found });
  }
  for (const removed of plan.removed) {
    say(
      `  not in the map any more: ${removed.destinationId} (last got ${removed.lastReceipt.generation} at ${removed.lastReceipt.at}). keypin doesn't delete it.`,
    );
  }

  if (!writes.length) {
    say("Nothing to write: every destination already has this generation.");
    if (unfinishedOperations(state, keyId, environment).length) {
      await saveState(deps.files, path, finishAll(state, keyId, environment));
    }
    return 0;
  }

  if (!(await confirmed(deps, plan.needsApproval, request))) return NEEDS_APPROVAL;

  const id = crypto.randomUUID();
  state = startOperation(state, {
    id,
    keyId,
    environment,
    generation,
    startedAt: deps.now().toISOString(),
    planned: writes.map((w) => w.destinationId),
  });
  await saveState(deps.files, path, state);

  for (const { destinationId: written, found } of writes) {
    const label = describeTarget(found.target, key.env);
    try {
      const evidence = await found.destination.write(key.env, secret);
      state = recordReceipt(
        state,
        {
          keyId,
          environment,
          source: entry.ref,
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
      say("Stopped. Finished writes keep their receipts; run keypin publish again to continue.");
      return 1;
    }
  }

  state = finishAll(state, keyId, environment);
  await saveState(deps.files, path, state);
  say(`Published ${keyId} (${environment}) to ${writes.length} destination(s).`);
  return 0;
}

async function confirmed(
  deps: Deps,
  needsApproval: boolean,
  request: { yes: boolean; args: string[] },
): Promise<boolean> {
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  if (request.yes && !needsApproval) return true;
  if (deps.isTerminal) {
    const answer = await deps.ask(
      `Type yes to write${needsApproval ? " (this plan needs approval)" : ""}: `,
    );
    if (answer.trim() === "yes") return true;
    say("Not confirmed. Nothing was written.");
    return false;
  }
  say(
    needsApproval
      ? "Stopped: this plan needs approval, and --yes can't give it. Nothing was written."
      : "Stopped: no terminal to confirm on. Nothing was written. Add --yes, or confirm in a terminal.",
  );
  say(rerun(deps, request.args));
  return false;
}

function rerun(deps: Deps, args: readonly string[]): string {
  const command = [...deps.self, "publish", ...args].map(shellWord).join(" ");
  return `To approve, run this in a terminal:\n  cd ${shellWord(deps.cwd)} && ${command}`;
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function finishAll(state: State, keyId: string, environment: Environment): State {
  return unfinishedOperations(state, keyId, environment).reduce(
    (s, op) => finishOperation(s, op.id),
    state,
  );
}

function accountFacts(check: AccountCheck): string {
  return `publisher ${check.publisher}, destination account ${check.destinationAccount ?? "unknown"}`;
}

function describeTarget(target: PublishTarget, secretName: string): string {
  return `${destinationId(target, secretName)} (account ${target.account})`;
}
