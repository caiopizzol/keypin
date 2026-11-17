import { parseArgs } from "node:util";
import {
  approvalsFor,
  type EnvEntry,
  formatReference,
  generationOf,
  HeldForApproval,
  WriteRefused,
  type Issued,
  type IssuedKey,
  issuedFor,
  type Issuer,
  type IssuerCheck,
  type IssuerSpec,
  type ItemIds,
  type KeyEntry,
  type KeyOwner,
  localDay,
  loadState,
  messageOf,
  NothingChanged,
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
  vaultAccount,
  vaultAccounts,
  vaultName,
  vaultKindOf,
} from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { confirm, type Output, output } from "../output";
import { findMap, pickEnvironment } from "../project";
import { approval } from "../sign-in";
import {
  commandLine,
  confirmed,
  NEEDS_APPROVAL,
  planOnly,
  unattendedApproval,
  withoutPlan,
} from "../approval";
import {
  type Checked,
  checkAccounts,
  type Label,
  labels,
  locked,
  type PlanRow,
  publishRows,
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
  plan: boolean;
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
    options: {
      env: { type: "string" },
      yes: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [keyId, ...extra] = positionals;
  if (keyId === undefined || extra.length)
    throw new UsageError("keypin rotate takes one key: the variable name");
  const map = await findMap(deps);
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
  const label = labels(entry.publish, deps.destinations);
  const base = {
    key,
    entry,
    spec,
    owner,
    yes: values.yes,
    plan: values.plan,
    args,
    deps,
    out,
    label,
  };
  return locked(deps, (path) => rotateLocked({ ...base, path }));
}

async function rotateLocked(job: Job): Promise<number> {
  const { key, entry, spec, owner, deps, out } = job;
  const say = (text: string) => out.line(text);
  let state = await loadState(deps.files, job.path, deps.vaults);
  const input = {
    kinds: deps.destinations,
    vaults: deps.vaults,
    key,
    environment: owner.environment,
    mapFile: owner.mapFile,
    receipts: state.receipts,
  };

  say(
    `${out.bold(key.name)} ${owner.environment}  ${out.dim(`from ${formatReference(entry.ref, deps.vaults)} in ${vaultAccount(entry.ref, deps.vaults)}`)}`,
  );
  const stopped = await unattendedApproval(deps, out, {
    plan: job.plan,
    command: "rotate",
    args: job.args,
    refs: [entry.ref],
    approvals: ([ids = null]) => approvalsFor(input, ids),
    nothing: "Nothing was created.",
    stopped:
      "Stopped before reading the key: this rotation needs approval, and --yes can't give it. Nothing was read and nothing was created.",
  });
  if (stopped !== null) return stopped;

  const read = await readKeys(job);
  if (!read.ok) {
    say(`Stopped: couldn't read ${read.failed}. Nothing was created.`);
    return 1;
  }
  const generation = await generationOf(read.secret);
  const { steps: unpublished, removed } = planPublish({ ...input, generation, ids: read.ids });
  let next = nextRotation({
    issued: issuedFor(state, owner),
    issuer: spec.kind,
    generation,
    published: unpublished.every((step) => step.action === "skip"),
  });
  const issuer = deps.issuer(spec, read.admin);
  if (next.action === "wait") {
    const held = next.issued;
    const listed = await issuerLists(issuer, held.id, read.secret, out);
    if (listed === null) return 1;
    if (listed) {
      say(
        `\nStopped: ${vaultName(entry.ref, deps.vaults)} still holds the change that saves key ${shown(issuer, held.id)} for approval. Nothing was created.`,
      );
      say(heldSteps(job, issuer, held.id));
      return NEEDS_APPROVAL;
    }
    say(
      out.dim(
        `\nKey ${shown(issuer, held.id)} is gone from ${issuer.describe()}, so keypin creates a new one.`,
      ),
    );
    next = { action: "create", current: held.old.id, abandoned: null };
  }
  if (next.action === "resume" && next.issued.held) {
    next = { action: "resume", issued: { ...next.issued, held: false } };
    state = recordIssued(state, next.issued);
    if (!job.plan) await saveState(deps.files, job.path, state);
  }
  if (next.action === "create" && !(await vaultTakesWrites(job))) return 1;

  const inVault = next.action === "resume" ? next.issued.id : next.current;
  const check = await checkIssuer(issuer, inVault, read.secret, out);
  const checked = await checkAccounts(key, entry, deps, out, job.label);
  if (!check || !checked) {
    say("\nStopped: an account check failed. Nothing was created and nothing was written.");
    return 1;
  }
  const ready = { ids: read.ids, issuer, checked, removed };
  if (next.action === "resume" && check.gone !== undefined) {
    if (!(await vaultTakesWrites(job))) return 1;
    const { old } = next.issued;
    if (old.id !== null && !old.revoked)
      say(
        out.dim(
          `\nkeypin didn't revoke key ${shown(issuer, old.id)}, the one key ${shown(issuer, next.issued.id)} replaced. If nothing uses it, delete it at ${issuer.dashboard()}.`,
        ),
      );
    next = { action: "create", current: null, abandoned: null };
  }
  if (next.action === "resume")
    return resume(job, ready, next.issued, read.secret, unpublished, state);

  if (next.abandoned)
    say(
      `\n${out.dim(abandonedNote(next.abandoned, issuer, spec, vaultName(entry.ref, deps.vaults)))}`,
    );
  const current = check.gone === undefined ? (next.current ?? check.currentId ?? null) : null;
  const steps = planNewValue(input, read.ids);
  say("\nPlan");
  showPlan(out, [
    row("+", issuer.describe(), "create a new key", check.notes?.create),
    row(
      "~",
      vaultName(entry.ref, deps.vaults),
      `save it to ${formatReference(entry.ref, deps.vaults)}, rotated today`,
    ),
    ...publishRows(steps, job.label, deps.destinations),
    check.gone === undefined
      ? revokeRow(issuer, current, "after a second y", check.notes?.revoke)
      : row("=", issuer.describe(), `nothing to revoke: ${check.gone}`),
  ]);
  showRemoved(out, removed);
  const needsApproval = steps.some((step) => step.approval !== null);
  if (job.plan) return planOnly(deps, "rotate", job.args, needsApproval);
  say("");
  const ok = await confirmed(
    deps,
    {
      yes: job.yes,
      args: job.args,
      command: "rotate",
      needsApproval,
      question: `Rotate ${key.name}?`,
    },
    "Nothing was created.",
  );
  if (!ok) return NEEDS_APPROVAL;

  const created = await createKey(job, issuer);
  if ("unchanged" in created) {
    if (created.unchanged) say("Stopped. Nothing was created.");
    else mayHaveCreated(job, issuer, created.name);
    return 1;
  }
  const issued: Issued = {
    ...owner,
    issuer: spec.kind,
    id: created.id,
    generation: await generationOf(created.secret),
    at: deps.now().toISOString(),
    old: { id: current, generation, revoked: check.gone !== undefined },
  };
  const mayHold = vaultKindOf(deps.vaults, entry.ref.kind).holdsWrites === true;
  try {
    const pending = mayHold ? { ...issued, held: true } : issued;
    await saveState(deps.files, job.path, recordIssued(state, pending));
  } catch (error) {
    return undoCreate(
      job,
      issuer,
      created.id,
      `couldn't record the new key in ${job.path}: ${messageOf(error)}`,
    );
  }

  const saved = await saveKey(job, created.secret);
  if (saved === "refused")
    return undoCreate(
      job,
      issuer,
      created.id,
      `${vaultName(entry.ref, deps.vaults)} refused to save the new key`,
      () => saveState(deps.files, job.path, state),
    );
  state = recordIssued(state, issued);
  if (saved === "held") {
    say(
      `Stopped. The new key ${shown(issuer, created.id)} at ${issuer.describe()} stays valid: the change holds it.`,
    );
    say(heldSteps(job, issuer, created.id));
    return NEEDS_APPROVAL;
  }
  if (saved === "unknown") {
    const vault = vaultName(entry.ref, deps.vaults);
    say(
      `Stopped: keypin can't tell whether ${vault} saved the new key ${shown(issuer, created.id)}. Run this again, and keypin picks up from what ${vault} holds:\n  ${commandLine(deps, "rotate", job.args)}`,
    );
    return 1;
  }
  let ids: ItemIds;
  try {
    ids = await deps.vault().itemIds(entry.ref);
  } catch (error) {
    say(
      `    ${messageOf(error)}\nStopped. The new key is in ${vaultName(entry.ref, deps.vaults)}, and the old key still works. To continue, run:\n  ${commandLine(deps, "rotate", job.args)}`,
    );
    return 1;
  }
  return publishThenRevoke(job, { ...ready, ids }, issued, created.secret, steps, state);
}

async function vaultTakesWrites({ entry, deps, out }: Job): Promise<boolean> {
  try {
    await deps.vault().checkWrite?.(entry.ref);
    return true;
  } catch (error) {
    out.line(`Stopped: ${messageOf(error)}. Nothing was created.`);
    return false;
  }
}

function heldSteps(job: Job, issuer: Issuer, id: string): string {
  const again = commandLine(job.deps, "rotate", withoutPlan(job.args));
  return `Once someone approves it, run this again to publish the new key and revoke the old one:\n  ${again}\nIf the change is rejected or cancelled, delete key ${shown(issuer, id)} at ${issuer.dashboard()}, then run this again.`;
}

async function issuerLists(
  issuer: Issuer,
  id: string,
  current: Secret,
  out: Output,
): Promise<boolean | null> {
  try {
    const check = await issuer.checkAccount(id, current);
    return check.ok && check.gone === undefined;
  } catch (error) {
    out.line(
      `Stopped: couldn't check key ${shown(issuer, id)} at ${issuer.describe()}: ${messageOf(error)}. Nothing was created.`,
    );
    return null;
  }
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
    `\nResuming: keypin created key ${shown(ready.issuer, issued.id)} at ${ready.issuer.describe()} on ${issued.at}, and ${vaultName(job.entry.ref, job.deps.vaults)} holds it.`,
  );
  const published = steps.every((step) => step.action === "skip");
  if (published && !job.plan) return revokeOld(job, ready, issued, state);
  const old = issued.old.revoked ? null : issued.old.id;
  out.line("\nPlan");
  showPlan(out, [
    ...publishRows(steps, job.label, deps.destinations),
    ...(old === null
      ? []
      : [revokeRow(ready.issuer, old, published ? "after a y" : "after a second y")]),
  ]);
  showRemoved(out, ready.removed);
  const needsApproval = published || steps.some((step) => step.approval !== null);
  if (job.plan) return planOnly(deps, "rotate", job.args, needsApproval);
  out.line("");
  const total = writesFor(steps, ready.checked).length;
  const ok = await confirmed(deps, {
    yes: job.yes,
    args: job.args,
    command: "rotate",
    needsApproval,
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
      `Stopped. The new key is in ${vaultName(entry.ref, deps.vaults)}, and the old key still works. To continue, run:\n  ${commandLine(deps, "rotate", job.args)}`,
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
    `\nRotated ${out.bold(key.name)} (${owner.environment}): the new key is in ${vaultName(job.entry.ref, job.deps.vaults)} and the ${listed === 1 ? "destination" : `${listed} destinations`} in the map.`,
  );
  const behind = ready.removed.filter((r) => r.lastReceipt.generation !== issued.generation);
  if (behind.length) {
    out.line(
      "Not in the map any more, so keypin didn't write them; they may still use the old key:",
    );
    showRemoved(out, behind);
  }
  const old = issued.old.id;
  if (issued.old.revoked) return 0;
  if (old === null) {
    out.line(
      `keypin doesn't know which key at ${where} it replaced. Once nothing uses the old one, delete it at ${issuer.dashboard()}.`,
    );
    return 0;
  }
  const asked = job.args.filter((arg) => arg !== "--yes");
  const later = `To revoke it later, run this in a terminal:\n  ${commandLine(deps, "rotate", asked)}`;
  if (!deps.isTerminal) {
    out.line(
      `The old key ${shown(issuer, old)} still works. Revoking it needs a y in a terminal.\n${later}`,
    );
    return NEEDS_APPROVAL;
  }
  out.line(`The old key ${shown(issuer, old)} still works. Revoke it once nothing uses it.`);
  if (!(await confirm(deps, `Revoke the old key at ${where}?`))) {
    out.line(later);
    return 0;
  }
  try {
    await out.step(
      `${where}  revoking ${shown(issuer, old)}`,
      () => issuer.revoke(old),
      (result) => ({
        ok: true,
        text: `${where}  ${result === "revoked" ? "revoked" : "already gone:"} ${shown(issuer, old)}`,
      }),
    );
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    out.line(
      `Stopped: the old key ${shown(issuer, old)} may still work. To try again, run:\n  ${commandLine(deps, "rotate", job.args)}`,
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

function abandonedNote(old: Issued, issuer: Issuer, spec: IssuerSpec, vault: string): string {
  if (old.issuer !== spec.kind)
    return `keypin created key ${old.id} at ${old.issuer} on ${old.at}, before this key's issuer became ${issuer.describe()}. If nothing uses it, delete it at ${old.issuer}, not ${issuer.describe()}.`;
  return `keypin created key ${shown(issuer, old.id)} at ${issuer.describe()} on ${old.at}, but ${vault} doesn't hold it. If nothing uses it, delete it at ${issuer.dashboard()}.`;
}

function revokeRow(issuer: Issuer, old: string | null, when: string, detail?: string): PlanRow {
  return old === null
    ? row("-", issuer.describe(), "the old key stays: keypin doesn't know its ID")
    : row("-", issuer.describe(), `revoke the old key ${shown(issuer, old)}, ${when}`, detail);
}

function shown(issuer: Issuer, id: string): string {
  return issuer.label?.(id) ?? id;
}

function row(sign: PlanRow["sign"], place: string, why: string, detail?: string): PlanRow {
  return { sign, place, why, approval: false, detail: detail ?? null };
}

type Read =
  | { ok: true; secret: Secret; ids: ItemIds; admin: Secret }
  | { ok: false; failed: string };

function readKeys({ entry, spec, deps, out }: Job): Promise<Read> {
  const refs = [entry.ref, spec.admin];
  const account = vaultAccounts(refs, deps.vaults);
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
        ? `Read the key and the admin key ${formatReference(spec.admin, deps.vaults)}`
        : `Couldn't read from ${account}`,
    }),
    approval(deps, refs),
  );
}

async function checkIssuer(
  issuer: Issuer,
  inVault: string | null,
  current: Secret,
  out: Output,
): Promise<Extract<IssuerCheck, { ok: true }> | null> {
  const where = issuer.describe();
  try {
    const check = await out.step(
      `${where}  checking the admin key`,
      () => issuer.checkAccount(inVault, current),
      (result) => ({ ok: result.ok, text: `${where}  ${out.dim(result.facts)}` }),
    );
    if (check.ok) return check;
    out.line(`    ${check.reason}`);
    if (check.fix) out.line(`    fix: ${check.fix}`);
    return null;
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return null;
  }
}

async function createKey(
  { key, owner, deps, out }: Job,
  issuer: Issuer,
): Promise<IssuedKey | { unchanged: boolean; name: string }> {
  const where = issuer.describe();
  const now = deps.now();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const name = `${key.name} ${owner.environment} ${localDay(now)} ${time} ${deps.tag()}`;
  try {
    return await out.step(
      `${where}  creating ${name}`,
      () => issuer.create(name),
      (created) => ({ ok: true, text: `${where}  created ${name} (${shown(issuer, created.id)})` }),
    );
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return { unchanged: error instanceof NothingChanged, name };
  }
}

function mayHaveCreated({ deps, out, args }: Job, issuer: Issuer, name: string) {
  const again = commandLine(deps, "rotate", args);
  const why =
    issuer.lostCreate?.(name) ??
    `${issuer.describe()} may have made the new key before this failed. Delete any key named "${name}" at ${issuer.dashboard()} before you run this again.`;
  out.line(`Stopped: keypin didn't get the new key back. ${why}\n  ${again}`);
}

async function undoCreate(
  job: Job,
  issuer: Issuer,
  id: string,
  stopped: string,
  forget: () => Promise<unknown> = async () => {},
): Promise<number> {
  const { out } = job;
  const where = issuer.describe();
  const unrecorded = `Stopped: ${stopped}`;
  try {
    await out.step(
      `${where}  revoking the new key ${shown(issuer, id)}`,
      () => issuer.revoke(id),
      () => ({ ok: true, text: `${where}  revoked the new key ${shown(issuer, id)}` }),
    );
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    out.line(
      `${unrecorded}. keypin couldn't revoke it either: delete key ${shown(issuer, id)} at ${issuer.dashboard()}. The old key still works.`,
    );
    return 1;
  }
  out.line(`${unrecorded}. Revoked it at ${where}. Nothing changed.`);
  await forget().catch((error: unknown) =>
    out.line(
      `keypin couldn't update ${job.path}: ${messageOf(error)}. If the next run says to delete key ${shown(issuer, id)}, it's already revoked.`,
    ),
  );
  return 1;
}

async function saveKey(
  { entry, deps, out }: Job,
  secret: Secret,
): Promise<"saved" | "held" | "refused" | "unknown"> {
  const place = `${vaultName(entry.ref, deps.vaults)}  ${formatReference(entry.ref, deps.vaults)}`;
  const today = localDay(deps.now());
  try {
    await out.step(
      `${place}  saving the new key`,
      () => deps.vault().write(entry.ref, secret, { rotated: today }),
      () => ({ ok: true, text: `${place}  saved, rotated ${today}` }),
      approval(deps, [entry.ref]),
    );
    return "saved";
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    if (error instanceof HeldForApproval) return "held";
    return error instanceof WriteRefused ? "refused" : "unknown";
  }
}
