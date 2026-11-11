import { parseArgs } from "node:util";
import {
  approvalsFor,
  type Environment,
  formatReference,
  type KeysMap,
  generationOf,
  loadState,
  planPublish,
  publishEnvironment,
  saveState,
  type Secret,
  unfinishedOperations,
} from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { messageOf } from "../errors";
import { findMap, pickEnvironment } from "../project";
import {
  accountFacts,
  checkAccounts,
  describeTarget,
  finishAll,
  locked,
  NEEDS_APPROVAL,
  rerun,
  writeAll,
  writesFor,
} from "../publishing";
import { announce } from "../vault";

export { NEEDS_APPROVAL };

export async function publish(args: string[], deps: Deps): Promise<number> {
  const { keyId, env, yes } = parseRequest(args);
  const map = await findMap(deps.files, deps.cwd);
  const environment = pickEnvironment(map, env, publishEnvironment(map));
  const request = { keyId, environment, yes, args };
  return locked(deps, (path) => publishLocked(request, map, path, deps));
}

function parseRequest(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      env: { type: "string" },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [keyId, ...extra] = positionals;
  if (keyId === undefined || extra.length)
    throw new UsageError("keypin publish takes one key: the variable name");
  return { keyId, env: values.env, yes: values.yes };
}

async function publishLocked(
  request: { keyId: string; environment: Environment; yes: boolean; args: string[] },
  map: KeysMap,
  path: string,
  deps: Deps,
): Promise<number> {
  const { keyId, environment } = request;
  const key = map.keys.find((k) => k.name === keyId);
  if (!key) throw new Error(`${map.file} has no key "${keyId}"`);
  const entry = key.environments[environment];
  if (!entry) throw new Error(`key "${keyId}" has no ${environment} entry in ${map.file}`);

  const say = (text: string) => deps.stderr.write(`${text}\n`);
  say(`Publishing ${keyId} (${environment}) from ${formatReference(entry.ref)}`);
  say(`  1Password account: ${entry.ref.account}`);
  for (const target of entry.publish) say(`  to: ${describeTarget(target, key.name)}`);
  if (!entry.publish.length) {
    say(`The map lists no destinations for ${keyId} (${environment}); nothing to publish.`);
    return 1;
  }

  const state = await loadState(deps.files, path);
  const owner = { keyId, environment, mapFile: map.file };
  for (const op of unfinishedOperations(state, owner)) {
    say(
      `An earlier publish (started ${op.startedAt}, generation ${op.generation}) didn't finish: wrote ${op.done.length} of ${op.planned.length} (${op.done.join(", ") || "none"}). This run plans again from the receipts.`,
    );
  }

  const checked = await checkAccounts(key, entry, deps, say);
  if (!checked) {
    say("Stopped: an account check failed. Nothing was read and nothing was written.");
    return 1;
  }

  const approvals = approvalsFor({
    key,
    environment,
    mapFile: map.file,
    receipts: state.receipts,
  });
  if (approvals.length && !deps.isTerminal) {
    say("\nNeeds approval:");
    for (const approval of approvals) say(`  ${approval.approval}`);
    say(
      `Stopped before reading the value: this publish needs approval, and --yes can't give it. Nothing was read and nothing was written.`,
    );
    say(rerun(deps, "publish", request.args));
    return NEEDS_APPROVAL;
  }

  announce(deps.stderr, "the value to publish", [entry.ref]);
  let secret: Secret;
  try {
    secret = await deps.vault().read(entry.ref);
  } catch (error) {
    say(`Stopped: couldn't read ${keyId} (${formatReference(entry.ref)}): ${messageOf(error)}`);
    return 1;
  }
  const generation = await generationOf(secret);
  const plan = planPublish({
    key,
    environment,
    mapFile: map.file,
    receipts: state.receipts,
    generation,
  });

  say(`\nPlan for generation ${generation}:`);
  const writes = writesFor(plan.steps, checked);
  for (const step of plan.steps) {
    const found = checked.get(step.destinationId);
    say(`  ${step.action} ${describeTarget(step.target, key.name)}: ${step.reason}`);
    if (found) say(`    ${accountFacts(found.check)}`);
    if (step.approval) say(`    needs approval: ${step.approval}`);
  }
  for (const removed of plan.removed) {
    say(
      `  not in the map any more: ${removed.destinationId} (last got ${removed.lastReceipt.generation} at ${removed.lastReceipt.at}). keypin doesn't delete it.`,
    );
  }

  if (!writes.length) {
    say("Nothing to write: every destination already has this generation.");
    if (unfinishedOperations(state, owner).length) {
      await saveState(deps.files, path, finishAll(state, owner));
    }
    return 0;
  }

  if (!(await confirmed(deps, plan.needsApproval, request))) return NEEDS_APPROVAL;

  const written = await writeAll({
    key,
    environment,
    mapFile: map.file,
    entry,
    secret,
    generation,
    writes,
    state,
    path,
    deps,
    say,
  });
  if (!written.ok) {
    say("Stopped. Finished writes keep their receipts; run keypin publish again to continue.");
    return 1;
  }
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
  say(rerun(deps, "publish", request.args));
  return false;
}
