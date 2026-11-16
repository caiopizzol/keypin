import { parseArgs } from "node:util";
import {
  approvalsFor,
  type EnvEntry,
  type Environment,
  formatReference,
  messageOf,
  vaultAccount,
  vaultAccounts,
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
import { findMap, pickEnvironment } from "../project";
import { approval, signInFor } from "../sign-in";
import { confirmed, NEEDS_APPROVAL, planOnly, unattendedApproval } from "../approval";
import { count, type Output, output } from "../output";
import {
  type Checked,
  checkAccounts,
  finishAll,
  labels,
  locked,
  publishRows,
  showPlan,
  showRemoved,
  type Write,
  writeAll,
  writeJobs,
  writesFor,
} from "../publishing";

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
  const map = await findMap(deps);
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

function jobsFor(request: Request, map: KeysMap, say: (text: string) => void): Job[] {
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
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const say = (text: string) => out.line(text);
  const jobs = jobsFor(request, map, say);
  if (many && !jobs.length) {
    say(`No key in ${map.file} has ${environment} destinations; nothing to publish.`);
    return 1;
  }
  for (const { key, entry } of jobs) {
    if (!entry.publish.length) {
      say(`The map lists no destinations for ${key.name} (${environment}); nothing to publish.`);
      return 1;
    }
  }
  signInFor(
    deps,
    jobs.map((job) => job.entry.ref),
  );
  const label = labels(
    jobs.flatMap((job) => job.entry.publish),
    deps.destinations,
  );

  let state = await loadState(deps.files, path, deps.vaults);
  for (const { owner } of jobs) {
    for (const op of unfinishedOperations(state, owner)) {
      say(
        `An earlier publish (started ${op.startedAt}, generation ${op.generation}) didn't finish: wrote ${op.done.length} of ${op.planned.length} (${op.done.join(", ") || "none"}). This run plans again from the receipts.`,
      );
    }
  }

  const checks: Checks[] = [];
  for (const job of jobs) {
    const { key, entry } = job;
    say(
      `\n${out.bold(key.name)} ${environment}  ${out.dim(`from ${formatReference(entry.ref, deps.vaults)} in ${vaultAccount(entry.ref, deps.vaults)}`)}`,
    );
    const checked = await checkAccounts(key, entry, deps, out, label);
    if (checked) checks.push({ ...job, checked });
  }
  if (checks.length < jobs.length) {
    say("\nStopped: an account check failed. Nothing was read and nothing was written.");
    return 1;
  }

  const approvalsOf = (ids: readonly (ItemIds | null)[]) =>
    jobs.flatMap(({ key, owner }, index) =>
      approvalsFor(
        {
          kinds: deps.destinations,
          vaults: deps.vaults,
          key,
          environment,
          mapFile: owner.mapFile,
          receipts: state.receipts,
        },
        ids[index] ?? null,
      ),
    );
  say("");
  const stopped = await unattendedApproval(deps, out, {
    plan: request.plan,
    command: "publish",
    args: request.args,
    refs: jobs.map((job) => job.entry.ref),
    approvals: approvalsOf,
    nothing: "Nothing was written.",
    stopped: `Stopped before reading ${many ? "any value" : "the value"}: this publish needs approval, and --yes can't give it. Nothing was read and nothing was written.`,
  });
  if (stopped !== null) return stopped;

  const read = await readValues(checks, deps, out);
  if (!read.ok) {
    say(`Stopped: couldn't read ${read.failed}`);
    return 1;
  }

  const planned: Planned[] = [];
  let needsApproval = false;
  for (const job of read.jobs) {
    const { key, owner, checked, secret, ids } = job;
    const generation = await generationOf(secret);
    const plan = planPublish({
      kinds: deps.destinations,
      vaults: deps.vaults,
      key,
      environment,
      mapFile: owner.mapFile,
      receipts: state.receipts,
      generation,
      ids,
    });
    const writes = writesFor(plan.steps, checked);
    say(
      `\nPlan${many ? ` for ${out.bold(key.name)}` : ""}  ${out.dim(`generation ${generation}`)}`,
    );
    showPlan(out, publishRows(plan.steps, label, deps.destinations));
    showRemoved(out, plan.removed);
    needsApproval ||= plan.needsApproval;
    planned.push({ ...job, generation, writes });
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
    say(
      "\nNothing to write: the receipts on this machine show every destination already got this generation.",
    );
    return 0;
  }
  if (request.plan) return planOnly(deps, "publish", request.args, needsApproval);

  const jobsToWrite = writeJobs(
    pending.map((job) => ({ ...job, environment, mapFile: job.owner.mapFile })),
    deps.destinations,
  );
  const total = pending.reduce((sum, job) => sum + job.writes.length, 0);
  say("");
  const question = `Write ${count(total, "secret")}?`;
  if (!(await confirmed(deps, { ...request, command: "publish", needsApproval, question })))
    return NEEDS_APPROVAL;

  for (const [index, job] of jobsToWrite.entries()) {
    const written = await writeAll({ ...job, state, path, deps, out, label });
    state = written.state;
    if (!written.ok) {
      if (many) {
        const left = pending.slice(index).map((j) => j.key.name);
        say(`Not finished: ${left.join(", ")}.`);
      }
      say("Stopped. Finished writes keep their receipts; run keypin publish again to continue.");
      return 1;
    }
    say(
      `Published ${out.bold(job.key.name)} (${environment}) to ${count(job.writes.length, "destination")}.`,
    );
  }
  return 0;
}

type Read =
  | { ok: true; jobs: (Checks & { secret: Secret; ids: ItemIds })[] }
  | { ok: false; failed: string };

function readValues(checks: Checks[], deps: Deps, out: Output): Promise<Read> {
  const accounts = vaultAccounts(
    checks.map((job) => job.entry.ref),
    deps.vaults,
  );
  const values = count(checks.length, "value");
  return out.step(
    `Reading ${values} from ${accounts}`,
    async (): Promise<Read> => {
      const jobs = [];
      for (const job of checks) {
        try {
          jobs.push({ ...job, ...(await deps.vault().readItem(job.entry.ref)) });
        } catch (error) {
          return {
            ok: false,
            failed: `${job.key.name} (${formatReference(job.entry.ref, deps.vaults)}): ${messageOf(error)}`,
          };
        }
      }
      return { ok: true, jobs };
    },
    (read) => ({
      ok: read.ok,
      text: read.ok ? `Read ${values} from ${accounts}` : `Couldn't read from ${accounts}`,
    }),
    approval(
      deps,
      checks.map((job) => job.entry.ref),
    ),
  );
}
