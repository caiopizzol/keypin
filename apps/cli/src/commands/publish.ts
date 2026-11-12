import { parseArgs } from "node:util";
import {
  approvalsFor,
  type EnvEntry,
  type Environment,
  formatReference,
  type Generation,
  type ItemIds,
  type KeyEntry,
  type KeyOwner,
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
  type Checked,
  checkAccounts,
  describeTarget,
  finishAll,
  locked,
  NEEDS_APPROVAL,
  planOnly,
  rerun,
  type Say,
  type Write,
  writeAll,
  writesFor,
} from "../publishing";
import { announce, lookUpIds } from "../vault";

interface Request {
  keyId: string | null;
  environment: Environment;
  yes: boolean;
  plan: boolean;
  args: string[];
}

interface Job {
  key: KeyEntry;
  entry: EnvEntry;
  owner: KeyOwner;
}

interface Checks extends Job {
  checked: Map<string, Checked>;
}

interface Planned extends Checks {
  secret: Secret;
  ids: ItemIds;
  generation: Generation;
  writes: Write[];
}

export async function publish(args: string[], deps: Deps): Promise<number> {
  const { keyId, env, yes, plan } = parseRequest(args);
  const map = await findMap(deps.files, deps.cwd);
  const environment = pickEnvironment(map, env, publishEnvironment(map));
  const request = { keyId, environment, yes, plan, args };
  return locked(deps, (path) => publishLocked(request, map, path, deps));
}

function parseRequest(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      env: { type: "string" },
      yes: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [keyId, ...extra] = positionals;
  if (values.all) {
    if (positionals.length)
      throw new UsageError("keypin publish takes a variable name or --all, not both");
    return { keyId: null, env: values.env, yes: values.yes, plan: values.plan };
  }
  if (keyId === undefined || extra.length)
    throw new UsageError("keypin publish takes one key: the variable name, or --all");
  return { keyId, env: values.env, yes: values.yes, plan: values.plan };
}

function jobsFor(request: Request, map: KeysMap, say: Say): Job[] {
  const { keyId, environment } = request;
  const job = (key: KeyEntry, entry: EnvEntry): Job => ({
    key,
    entry,
    owner: { keyId: key.name, environment, mapFile: map.file },
  });
  if (keyId !== null) {
    const key = map.keys.find((k) => k.name === keyId);
    if (!key) throw new Error(`${map.file} has no key "${keyId}"`);
    const entry = key.environments[environment];
    if (!entry) throw new Error(`key "${keyId}" has no ${environment} entry in ${map.file}`);
    return [job(key, entry)];
  }
  const jobs = map.keys.flatMap((key) => {
    const entry = key.environments[environment];
    return entry?.publish.length ? [job(key, entry)] : [];
  });
  const skipped = map.keys.filter((key) => !jobs.some((j) => j.key === key));
  if (skipped.length)
    say(`Not published, no ${environment} destinations: ${skipped.map((k) => k.name).join(", ")}`);
  return jobs;
}

async function publishLocked(
  request: Request,
  map: KeysMap,
  path: string,
  deps: Deps,
): Promise<number> {
  const { environment } = request;
  const many = request.keyId === null;
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  const jobs = jobsFor(request, map, say);
  if (many && !jobs.length) {
    say(`No key in ${map.file} has ${environment} destinations; nothing to publish.`);
    return 1;
  }

  for (const { key, entry } of jobs) {
    say(`Publishing ${key.name} (${environment}) from ${formatReference(entry.ref)}`);
    say(`  1Password account: ${entry.ref.account}`);
    for (const target of entry.publish) say(`  to: ${describeTarget(target, key.name)}`);
    if (!entry.publish.length) {
      say(`The map lists no destinations for ${key.name} (${environment}); nothing to publish.`);
      return 1;
    }
  }

  let state = await loadState(deps.files, path);
  for (const { owner } of jobs) {
    for (const op of unfinishedOperations(state, owner)) {
      say(
        `An earlier publish (started ${op.startedAt}, generation ${op.generation}) didn't finish: wrote ${op.done.length} of ${op.planned.length} (${op.done.join(", ") || "none"}). This run plans again from the receipts.`,
      );
    }
  }

  const checks: Checks[] = [];
  for (const job of jobs) {
    const heading = many ? `Account checks for ${job.key.name}` : "Account checks";
    const checked = await checkAccounts(job.key, job.entry, deps, say, heading);
    if (checked) checks.push({ ...job, checked });
  }
  if (checks.length < jobs.length) {
    say("Stopped: an account check failed. Nothing was read and nothing was written.");
    return 1;
  }

  const approvalsOf = (ids: (ItemIds | null)[]) =>
    jobs.flatMap(({ key, owner }, index) =>
      approvalsFor(
        { key, environment, mapFile: owner.mapFile, receipts: state.receipts },
        ids[index] ?? null,
      ),
    );
  const unattended = !deps.isTerminal && !request.plan;
  let approvals = approvalsOf([]);
  if (unattended && !approvals.length) {
    try {
      approvals = approvalsOf(
        await lookUpIds(
          deps,
          jobs.map((job) => job.entry.ref),
        ),
      );
    } catch (error) {
      say(`Stopped: couldn't find the item: ${messageOf(error)}. Nothing was written.`);
      return 1;
    }
  }
  if (approvals.length && unattended) {
    say("\nNeeds approval:");
    for (const approval of approvals) say(`  ${approval.approval}`);
    say(
      `Stopped before reading ${many ? "any value" : "the value"}: this publish needs approval, and --yes can't give it. Nothing was read and nothing was written.`,
    );
    say(rerun(deps, "publish", request.args));
    return NEEDS_APPROVAL;
  }

  announce(
    deps.stderr,
    many ? "the values to publish" : "the value to publish",
    jobs.map((job) => job.entry.ref),
  );
  const planned: Planned[] = [];
  let needsApproval = false;
  for (const job of checks) {
    const { key, entry, owner, checked } = job;
    let secret: Secret;
    let ids: ItemIds;
    try {
      ({ secret, ids } = await deps.vault().readItem(entry.ref));
    } catch (error) {
      say(
        `Stopped: couldn't read ${key.name} (${formatReference(entry.ref)}): ${messageOf(error)}`,
      );
      return 1;
    }
    const generation = await generationOf(secret);
    const plan = planPublish({
      key,
      environment,
      mapFile: owner.mapFile,
      receipts: state.receipts,
      generation,
      ids,
    });
    const writes = writesFor(plan.steps, checked);
    say(
      many
        ? `\nPlan for ${key.name}, generation ${generation}:`
        : `\nPlan for generation ${generation}:`,
    );
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
    needsApproval ||= plan.needsApproval;
    planned.push({ ...job, secret, ids, generation, writes });
  }

  const finished = planned
    .filter((job) => !job.writes.length && unfinishedOperations(state, job.owner).length)
    .reduce((s, job) => finishAll(s, job.owner), state);
  if (finished !== state && !request.plan) {
    state = finished;
    await saveState(deps.files, path, state);
  }

  const pending = planned.filter((job) => job.writes.length);
  if (!pending.length) {
    say("Nothing to write: every destination already has this generation.");
    return 0;
  }
  if (request.plan) return planOnly(deps, "publish", request.args, needsApproval);

  if (!(await confirmed(deps, needsApproval, request))) return NEEDS_APPROVAL;

  for (const [index, job] of pending.entries()) {
    const written = await writeAll({
      key: job.key,
      environment,
      mapFile: job.owner.mapFile,
      entry: job.entry,
      secret: job.secret,
      ids: job.ids,
      generation: job.generation,
      writes: job.writes,
      state,
      path,
      deps,
      say,
    });
    state = written.state;
    if (!written.ok) {
      if (many) {
        const left = pending.slice(index).map((j) => j.key.name);
        say(`Not finished: ${left.join(", ")}.`);
      }
      say("Stopped. Finished writes keep their receipts; run keypin publish again to continue.");
      return 1;
    }
    say(`Published ${job.key.name} (${environment}) to ${job.writes.length} destination(s).`);
  }
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
