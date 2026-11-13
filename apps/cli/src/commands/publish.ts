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
  type PlanStep,
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
import { columns, confirm, type Output, output } from "../output";
import {
  type Checked,
  checkAccounts,
  finishAll,
  labels,
  locked,
  NEEDS_APPROVAL,
  planOnly,
  rerun,
  type Say,
  type Write,
  writeAll,
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
  const label = labels(jobs.flatMap((job) => job.entry.publish));

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
    const { key, entry } = job;
    say(
      `\n${out.bold(key.name)} ${environment}  ${out.dim(`from ${formatReference(entry.ref)} in 1Password account ${entry.ref.account}`)}`,
    );
    const checked = await checkAccounts(key, entry, deps, out, label);
    if (checked) checks.push({ ...job, checked });
  }
  if (checks.length < jobs.length) {
    say("\nStopped: an account check failed. Nothing was read and nothing was written.");
    return 1;
  }

  const approvalsOf = (ids: (ItemIds | null)[]) =>
    jobs.flatMap(({ key, owner }, index) =>
      approvalsFor(
        { key, environment, mapFile: owner.mapFile, receipts: state.receipts },
        ids[index] ?? null,
      ),
    );
  say("");
  const unattended = !deps.isTerminal && !request.plan;
  let approvals = approvalsOf([]);
  if (unattended && !approvals.length) {
    try {
      approvals = approvalsOf(await lookUpIds(jobs, deps, out));
    } catch (error) {
      say(`Stopped: couldn't find the item: ${messageOf(error)}. Nothing was written.`);
      return 1;
    }
  }
  if (approvals.length && unattended) {
    say("Needs approval:");
    for (const approval of approvals) say(`  ${approval.approval}`);
    say(
      `Stopped before reading ${many ? "any value" : "the value"}: this publish needs approval, and --yes can't give it. Nothing was read and nothing was written.`,
    );
    say(rerun(deps, "publish", request.args));
    return NEEDS_APPROVAL;
  }

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
    const rows = columns(plan.steps.map((step) => [label(step.target), WHY[step.reason]]));
    plan.steps.forEach((step, index) => {
      const [place = "", why = ""] = rows[index] ?? [];
      const text = `${step.action === "skip" ? "=" : step.approval ? "+" : "~"} ${place}  ${why}`;
      const approval = step.approval ? `  ${out.bold("needs approval")}` : "";
      say(`  ${step.action === "skip" ? out.dim(text.trimEnd()) : `${text}${approval}`}`);
      if (step.reason === "account changed" || step.reason === "item changed")
        say(`    ${out.dim(step.approval ?? "")}`);
    });
    for (const removed of plan.removed) {
      say(
        `  ${out.dim(`- ${removed.destinationId}: not in the map any more (last got ${removed.lastReceipt.generation} at ${removed.lastReceipt.at}). keypin doesn't delete it.`)}`,
      );
    }
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

  const total = pending.reduce((sum, job) => sum + job.writes.length, 0);
  say("");
  if (!(await confirmed(deps, needsApproval, request, total))) return NEEDS_APPROVAL;

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
      out,
      label,
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
    say(
      `Published ${out.bold(job.key.name)} (${environment}) to ${count(job.writes.length, "destination")}.`,
    );
  }
  return 0;
}

const WHY: Record<PlanStep["reason"], string> = {
  "no receipt": "first write",
  "new destination": "first write",
  "account changed": "account changed",
  "item changed": "vault item changed",
  "different generation": "new value",
  "receipt already has this generation": "already has this value",
};

type Read =
  | { ok: true; jobs: (Checks & { secret: Secret; ids: ItemIds })[] }
  | { ok: false; failed: string };

async function lookUpIds(jobs: Job[], deps: Deps, out: Output): Promise<ItemIds[]> {
  const items = count(jobs.length, "item ID");
  return out.step(
    `Looking up ${items} in 1Password, not the values`,
    async () => {
      const ids: ItemIds[] = [];
      for (const job of jobs) ids.push(await deps.vault().itemIds(job.entry.ref));
      return ids;
    },
    () => ({ ok: true, text: `Looked up ${items} in 1Password, not the values` }),
    "1Password may be asking you to approve keypin",
  );
}

function readValues(checks: Checks[], deps: Deps, out: Output): Promise<Read> {
  const accounts = [...new Set(checks.map((job) => job.entry.ref.account))].join(", ");
  const values = count(checks.length, "value");
  return out.step(
    `Reading ${values} from 1Password account ${accounts}`,
    async (): Promise<Read> => {
      const jobs = [];
      for (const job of checks) {
        try {
          jobs.push({ ...job, ...(await deps.vault().readItem(job.entry.ref)) });
        } catch (error) {
          return {
            ok: false,
            failed: `${job.key.name} (${formatReference(job.entry.ref)}): ${messageOf(error)}`,
          };
        }
      }
      return { ok: true, jobs };
    },
    (read) => ({
      ok: read.ok,
      text: read.ok
        ? `Read ${values} from 1Password account ${accounts}`
        : `Couldn't read from 1Password account ${accounts}`,
    }),
    "1Password may be asking you to approve keypin",
  );
}

async function confirmed(
  deps: Deps,
  needsApproval: boolean,
  request: { yes: boolean; args: string[] },
  total: number,
): Promise<boolean> {
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  if (request.yes && !needsApproval) return true;
  if (deps.isTerminal) {
    if (await confirm(deps, `Write ${count(total, "secret")}?`)) return true;
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

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
