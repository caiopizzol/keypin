import { parseArgs } from "node:util";
import {
  approvalsFor,
  type EnvEntry,
  formatReference,
  generationOf,
  type Issued,
  issuedFor,
  type Issuer,
  type IssuerSpec,
  type ItemIds,
  type KeyEntry,
  type KeyOwner,
  loadState,
  nextRotation,
  planNewValue,
  planPublish,
  type PlanStep,
  publishEnvironment,
  recordIssued,
  type RemovedDestination,
  saveState,
  type Secret,
  type State,
} from "@keypin/core";
import { type Deps, localDay, UsageError } from "../deps";
import { messageOf } from "../errors";
import { confirm, type Output, output } from "../output";
import { findMap, pickEnvironment } from "../project";
import { approval } from "../sign-in";
import {
  type Checked,
  checkAccounts,
  commandLine,
  confirmed,
  type Label,
  labels,
  locked,
  lookUpIds,
  NEEDS_APPROVAL,
  type PlanRow,
  publishRows,
  rerun,
  showPlan,
  showRemoved,
  writeAll,
  writesFor,
} from "../publishing";

interface Job {
  key: KeyEntry;
  entry: EnvEntry;
  spec: IssuerSpec;
  owner: KeyOwner;
  yes: boolean;
  args: string[];
  deps: Deps;
  out: Output;
  label: Label;
  path: string;
}

interface Ready {
  ids: ItemIds;
  issuer: Issuer;
  checked: Map<string, Checked>;
  removed: RemovedDestination[];
}

export async function rotate(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { env: { type: "string" }, yes: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const [keyId, ...extra] = positionals;
  if (keyId === undefined || extra.length)
    throw new UsageError("keypin rotate takes one key: the variable name");
  const map = await findMap(deps.files, deps.cwd);
  const environment = pickEnvironment(map, values.env, publishEnvironment(map));
  const key = map.keys.find((k) => k.name === keyId);
  if (!key) throw new Error(`${map.file} has no key "${keyId}"`);
  const entry = key.environments[environment];
  if (!entry) throw new Error(`key "${keyId}" has no ${environment} entry in ${map.file}`);
  const spec = entry.issuer;
  if (!spec)
    throw new Error(
      `key "${keyId}" ${environment} has no issuer in ${map.file}, so keypin can't make a new key. Add one (see docs/configuration.md), or rotate it by hand.`,
    );
  if (!entry.publish.length)
    throw new Error(
      `the map lists no destinations for ${keyId} (${environment}); add them first, so the new key reaches what uses it`,
    );
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const owner = { keyId, environment, mapFile: map.file };
  const label = labels(entry.publish);
  const base = { key, entry, spec, owner, yes: values.yes, args, deps, out, label };
  return locked(deps, (path) => rotateLocked({ ...base, path }));
}

async function rotateLocked(job: Job): Promise<number> {
  const { key, entry, spec, owner, deps, out } = job;
  const say = (text: string) => out.line(text);
  let state = await loadState(deps.files, job.path);
  const input = {
    key,
    environment: owner.environment,
    mapFile: owner.mapFile,
    receipts: state.receipts,
  };

  say(
    `${out.bold(key.name)} ${owner.environment}  ${out.dim(`from ${formatReference(entry.ref)} in 1Password account ${entry.ref.account}`)}`,
  );
  let approvals = approvalsFor(input);
  if (!deps.isTerminal && !approvals.length) {
    try {
      const [ids = null] = await lookUpIds([entry.ref], deps, out);
      approvals = approvalsFor(input, ids);
    } catch (error) {
      say(`Stopped: couldn't find the item: ${messageOf(error)}. Nothing was created.`);
      return 1;
    }
  }
  if (!deps.isTerminal && approvals.length) {
    say("Needs approval:");
    for (const needed of approvals) say(`  ${needed.approval}`);
    say(
      "Stopped before reading the key: this rotation needs approval, and --yes can't give it. Nothing was read and nothing was created.",
    );
    say(rerun(deps, "rotate", job.args));
    return NEEDS_APPROVAL;
  }

  const read = await readKeys(job);
  if (!read.ok) {
    say(`Stopped: couldn't read ${read.failed}. Nothing was created.`);
    return 1;
  }
  const generation = await generationOf(read.secret);
  const { steps: unpublished, removed } = planPublish({ ...input, generation, ids: read.ids });
  const next = nextRotation({
    issued: issuedFor(state, owner),
    issuer: spec.kind,
    generation,
    published: unpublished.every((step) => step.action === "skip"),
  });
  if (next.action === "create" && !deps.vault().capabilities.write) {
    say(
      "Stopped: saving a new key to 1Password needs the desktop app, and this machine signs in with a service account. Nothing was created.",
    );
    return 1;
  }

  const issuer = deps.issuer(spec, read.admin);
  const inVault = next.action === "resume" ? next.issued.id : next.current;
  const issuerOk = await checkIssuer(issuer, inVault, out);
  const checked = await checkAccounts(key, entry, deps, out, job.label);
  if (!issuerOk || !checked) {
    say("\nStopped: an account check failed. Nothing was created and nothing was written.");
    return 1;
  }
  const ready = { ids: read.ids, issuer, checked, removed };
  if (next.action === "resume")
    return resume(job, ready, next.issued, read.secret, unpublished, state);

  if (next.abandoned) say(`\n${out.dim(abandonedNote(next.abandoned, issuer, spec))}`);
  const steps = planNewValue(input, read.ids);
  say("\nPlan");
  showPlan(out, [
    row("+", issuer.describe(), "create a new key"),
    row("~", "1Password", `save it to ${formatReference(entry.ref)}, rotated today`),
    ...publishRows(steps, job.label),
    row(
      "-",
      issuer.describe(),
      next.current === null
        ? "the old key stays: keypin doesn't know its ID"
        : `revoke the old key ${next.current}, after a second y`,
    ),
  ]);
  showRemoved(out, removed);
  say("");
  const ok = await confirmed(
    deps,
    {
      yes: job.yes,
      args: job.args,
      command: "rotate",
      needsApproval: steps.some((step) => step.approval !== null),
      question: `Rotate ${key.name}?`,
    },
    "Nothing was created.",
  );
  if (!ok) return NEEDS_APPROVAL;

  const created = await createKey(job, issuer);
  if (!created) {
    say("Stopped. Nothing was created.");
    return 1;
  }
  const issued: Issued = {
    ...owner,
    issuer: spec.kind,
    id: created.id,
    generation: await generationOf(created.secret),
    at: deps.now().toISOString(),
    old: { id: next.current, generation, revoked: false },
  };
  state = recordIssued(state, issued);
  await saveState(deps.files, job.path, state);

  if (!(await saveKey(job, created.secret))) {
    say(
      `Stopped: the new key ${created.id} exists at ${issuer.describe()} but isn't in 1Password, and keypin can't show it again. Delete it at ${issuer.dashboard()}, then run this again:\n  ${commandLine(deps, "rotate", job.args)}`,
    );
    return 1;
  }
  return publishThenRevoke(job, ready, issued, created.secret, steps, state);
}

async function resume(
  job: Job,
  ready: Ready,
  issued: Issued,
  secret: Secret,
  steps: PlanStep[],
  state: State,
): Promise<number> {
  const { out, deps } = job;
  out.line(
    `\nResuming: keypin created key ${issued.id} at ${ready.issuer.describe()} on ${issued.at}, and 1Password holds it.`,
  );
  if (steps.every((step) => step.action === "skip")) return revokeOld(job, ready, issued, state);
  out.line("\nPlan");
  showPlan(out, publishRows(steps, job.label));
  showRemoved(out, ready.removed);
  out.line("");
  const total = writesFor(steps, ready.checked).length;
  const ok = await confirmed(deps, {
    yes: job.yes,
    args: job.args,
    command: "rotate",
    needsApproval: steps.some((step) => step.approval !== null),
    question: `Write ${total} secret${total === 1 ? "" : "s"}?`,
  });
  if (!ok) return NEEDS_APPROVAL;
  return publishThenRevoke(job, ready, issued, secret, steps, state);
}

async function publishThenRevoke(
  job: Job,
  ready: Ready,
  issued: Issued,
  secret: Secret,
  steps: PlanStep[],
  state: State,
): Promise<number> {
  const { key, entry, owner, deps, out } = job;
  const written = await writeAll({
    key,
    environment: owner.environment,
    mapFile: owner.mapFile,
    entry,
    secret,
    ids: ready.ids,
    generation: issued.generation,
    writes: writesFor(steps, ready.checked),
    state,
    path: job.path,
    deps,
    out,
    label: job.label,
  });
  if (!written.ok) {
    out.line(
      `Stopped. The new key is in 1Password, and the old key still works. To continue, run:\n  ${commandLine(deps, "rotate", job.args)}`,
    );
    return 1;
  }
  return revokeOld(job, ready, issued, written.state);
}

async function revokeOld(job: Job, ready: Ready, issued: Issued, state: State): Promise<number> {
  const { key, owner, deps, out } = job;
  const { issuer } = ready;
  const where = issuer.describe();
  const listed = job.entry.publish.length;
  out.line(
    `\nRotated ${out.bold(key.name)} (${owner.environment}): the new key is in 1Password and the ${listed === 1 ? "destination" : `${listed} destinations`} in the map.`,
  );
  const behind = ready.removed.filter((r) => r.lastReceipt.generation !== issued.generation);
  if (behind.length) {
    out.line(
      "Not in the map any more, so keypin didn't write them; they may still use the old key:",
    );
    showRemoved(out, behind);
  }
  const old = issued.old.id;
  if (old === null) {
    out.line(
      `keypin doesn't know which key at ${where} it replaced. Once nothing uses the old one, delete it at ${issuer.dashboard()}.`,
    );
    return 0;
  }
  if (issued.old.revoked) return 0;
  const asked = job.args.filter((arg) => arg !== "--yes");
  const later = `To revoke it later, run this in a terminal:\n  ${commandLine(deps, "rotate", asked)}`;
  if (!deps.isTerminal) {
    out.line(`The old key ${old} still works. Revoking it needs a y in a terminal.\n${later}`);
    return NEEDS_APPROVAL;
  }
  out.line(`The old key ${old} still works. Revoke it once nothing uses it.`);
  if (!(await confirm(deps, `Revoke the old key at ${where}?`))) {
    out.line(later);
    return 0;
  }
  try {
    await out.step(
      `${where}  revoking ${old}`,
      () => issuer.revoke(old),
      (result) => ({
        ok: true,
        text: `${where}  ${result === "revoked" ? "revoked" : "already gone:"} ${old}`,
      }),
    );
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    out.line(
      `Stopped: the old key ${old} may still work. To try again, run:\n  ${commandLine(deps, "rotate", job.args)}`,
    );
    return 1;
  }
  await saveState(
    deps.files,
    job.path,
    recordIssued(state, { ...issued, old: { ...issued.old, revoked: true } }),
  );
  return 0;
}

function abandonedNote(old: Issued, issuer: Issuer, spec: IssuerSpec): string {
  if (old.issuer !== spec.kind)
    return `keypin created key ${old.id} at ${old.issuer} on ${old.at}, before this key's issuer became ${issuer.describe()}. If nothing uses it, delete it at ${old.issuer}, not ${issuer.describe()}.`;
  return `keypin created key ${old.id} at ${issuer.describe()} on ${old.at}, but 1Password doesn't hold it. If nothing uses it, delete it at ${issuer.dashboard()}.`;
}

function row(sign: PlanRow["sign"], place: string, why: string): PlanRow {
  return { sign, place, why, approval: false, detail: null };
}

type Read =
  | { ok: true; secret: Secret; ids: ItemIds; admin: Secret }
  | { ok: false; failed: string };

function readKeys({ entry, spec, deps, out }: Job): Promise<Read> {
  const account = `1Password account ${entry.ref.account}`;
  return out.step(
    `Reading the key and the admin key from ${account}`,
    async (): Promise<Read> => {
      try {
        const current = await deps.vault().readItem(entry.ref);
        const admin = await deps.vault().read(spec.admin);
        return { ok: true, ...current, admin };
      } catch (error) {
        return { ok: false, failed: messageOf(error) };
      }
    },
    (read) => ({
      ok: read.ok,
      text: read.ok
        ? `Read the key and the admin key ${formatReference(spec.admin)}`
        : `Couldn't read from ${account}`,
    }),
    approval(deps),
  );
}

async function checkIssuer(issuer: Issuer, inVault: string | null, out: Output): Promise<boolean> {
  const where = issuer.describe();
  try {
    const check = await out.step(
      `${where}  checking the admin key`,
      () => issuer.checkAccount(inVault),
      (result) => ({ ok: result.ok, text: `${where}  ${out.dim(result.facts)}` }),
    );
    if (!check.ok) {
      out.line(`    ${check.reason ?? "the check failed"}`);
      if (check.fix) out.line(`    fix: ${check.fix}`);
    }
    return check.ok;
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return false;
  }
}

async function createKey({ key, owner, deps, out }: Job, issuer: Issuer) {
  const where = issuer.describe();
  const name = `${key.name} ${owner.environment} ${localDay(deps.now())}`;
  try {
    return await out.step(
      `${where}  creating ${name}`,
      () => issuer.create(name),
      (created) => ({ ok: true, text: `${where}  created ${name} (${created.id})` }),
    );
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return null;
  }
}

async function saveKey({ entry, deps, out }: Job, secret: Secret): Promise<boolean> {
  const place = `1Password  ${formatReference(entry.ref)}`;
  const today = localDay(deps.now());
  try {
    await out.step(
      `${place}  saving the new key`,
      () => deps.vault().write(entry.ref, secret, { rotated: today }),
      () => ({ ok: true, text: `${place}  saved, rotated ${today}` }),
      approval(deps),
    );
    return true;
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return false;
  }
}
