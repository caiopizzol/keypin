import {
  restoreIssued,
  restoreReceipts,
  waitsForRevoke,
  approvalsFor,
  formatReference,
  generationOf,
  type Issued,
  issuedFor,
  type ItemIds,
  type KeyEntry,
  keyIdText,
  loadState,
  messageOf,
  nextRotation,
  planNewValue,
  type PlanInput,
  planPublish,
  recordIssued,
  saveState,
  Secret,
  vaultAccount,
  vaultName,
  vaultKindOf,
} from "@keypin/core";
import {
  commandLine,
  confirmed,
  NEEDS_APPROVAL,
  planOnly,
  unattendedApproval,
} from "../../approval";
import { checkAccounts, lookUpIds, showPlan, showRemoved } from "../../publishing";
import { type Job, type Ready, withoutDiscard, terminalArgs } from "./job";
import { resume, publishThenRevoke } from "./finish";
import {
  readKeys,
  checkIssuer,
  createKey,
  mayHaveCreated,
  undoCreate,
  saveKey,
  saveId,
  itemIdsAfterSave,
  vaultTakesWrites,
  issuerLists,
  revokeOrphan,
} from "./vault-and-issuer";
import {
  row,
  revokeRow,
  revokeWhen,
  saveIdRow,
  writeRows,
  shown,
  apartNote,
  oldStays,
  abandonedNote,
  heldSteps,
  resetStop,
  shortLifetime,
} from "./messages";
import { routineWrites } from "./routine-check";
import { revokeOnly, resetHeld, neverSaved } from "./unfinished-rotation";
import { pairChecks } from "./pair-checks";
import { readerRows, unreadNote } from "./readers";

export async function rotateLocked(job: Job): Promise<number> {
  const { key, entry, spec, owner, deps, out } = job;
  const say = (text: string) => out.line(text);
  let looked: ItemIds[] | undefined;
  let state = await restoreReceipts({
    state: restoreIssued(
      await loadState(deps.files, job.path, deps.vaults),
      job.committed,
      job.map,
    ),
    file: job.committed,
    map: job.map,
    kinds: deps.destinations,
    owner,
    ids: async () => {
      looked = await lookUpIds([entry.ref], deps, out);
      const [ids] = looked;
      if (!ids) throw new Error(`couldn't find ${formatReference(entry.ref, deps.vaults)}`);
      return ids;
    },
  });
  const inputFor = (of: KeyEntry): PlanInput => ({
    kinds: deps.destinations,
    vaults: deps.vaults,
    key: of,
    environment: owner.environment,
    mapFile: owner.mapFile,
    receipts: state.receipts,
  });
  const input = inputFor(key);
  const pairInput = job.pair ? inputFor(job.pair.key) : null;

  say(
    `${out.bold(key.name)} ${owner.environment}  ${out.dim(`from ${formatReference(entry.ref, deps.vaults)} in ${vaultAccount(entry.ref, deps.vaults)}`)}`,
  );
  const approvals = ([ids = null, pairIds = null]: readonly (ItemIds | null)[]) => [
    ...approvalsFor(input, ids),
    ...(pairInput ? approvalsFor(pairInput, pairIds) : []),
  ];
  if (job.check && !(await routineWrites(job, approvals, looked))) return 1;
  const stopped = await unattendedApproval(deps, out, {
    plan: job.plan,
    command: "rotate",
    args: job.args,
    refs: job.pair ? [entry.ref, job.pair.entry.ref] : [entry.ref],
    approvals,
    nothing: "Nothing was created.",
    stopped:
      "Stopped before reading the key: this rotation needs approval, and --yes can't give it. Nothing was read and nothing was created.",
    ...(looked && !job.pair ? { ids: looked } : {}),
  });
  if (stopped !== null) return stopped;

  const read = await readKeys(job);
  if (!read.ok) {
    say(`Stopped: couldn't read ${read.failed}. Nothing was created.`);
    return 1;
  }
  const generation = await generationOf(read.secret);
  const { steps: unpublished, removed } = planPublish({ ...input, generation, ids: read.ids });
  const pairPlan = (value: Secret) =>
    pairInput && read.pair
      ? generationOf(value).then((g) =>
          planPublish({ ...pairInput, generation: g, ids: read.pair?.ids ?? null }),
        )
      : null;
  const pairNow = read.pair ? await pairPlan(read.pair.secret) : null;
  const recorded = issuedFor(state, owner);
  const idSaved = !read.pair || !recorded || read.pair.secret.equals(new Secret(recorded.id));
  const counted = [...unpublished, ...(pairNow?.steps ?? [])];
  let next = nextRotation({
    issued: recorded,
    issuer: spec.kind,
    generation,
    published: counted.every((step) => step.action === "skip"),
    idSaved,
  });
  const unfinished = next.action !== "create";
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
  if (next.action === "resume" && (next.issued.held || next.issued.unsaved)) {
    next = { action: "resume", issued: { ...next.issued, held: false, unsaved: false } };
    state = recordIssued(state, next.issued);
    if (!job.plan) await saveState(deps.files, job.path, state);
  }
  if (job.discard && !unfinished) {
    const vault = vaultName(entry.ref, deps.vaults);
    const left = next.action === "create" ? next.abandoned : null;
    const note = left ? abandonedNote(left, issuer, spec, vault) : null;
    say(
      `Stopped: ${key.name} (${owner.environment}) has no unfinished rotation to discard. ${note ?? `To replace the key ${vault} holds, run:\n  ${commandLine(deps, "rotate", withoutDiscard(job.args))}`}\nNothing was created.`,
    );
    return 1;
  }
  if (job.approve && !revokeOnly(next, counted, idSaved)) {
    say(
      next.action === "resume" && waitsForRevoke(next.issued)
        ? `Stopped: not every destination has the new key ${shown(issuer, next.issued.id)}, so keypin won't revoke the old one. Run keypin rotate --due to publish it first. Nothing was revoked.`
        : `Stopped: ${key.name} (${owner.environment}) has no new key waiting for approval: the vault holds another value. Nothing was revoked.`,
    );
    return 1;
  }
  if (next.action === "create" && !(await vaultTakesWrites(job))) return 1;

  const inVault =
    next.action === "resume"
      ? next.issued.id
      : read.pair
        ? keyIdText(read.pair.secret)
        : next.current;
  const check = await checkIssuer(issuer, inVault, read.secret, out, spec.admin !== undefined);
  const checked = await checkAccounts(key, entry, deps, out, job.label);
  if (!check || !checked) {
    say("\nStopped: an account check failed. Nothing was created and nothing was written.");
    return 1;
  }
  const reset = resetHeld(
    issuer,
    spec,
    next.action === "create" ? next.abandoned : null,
    generation,
  );
  if (job.check) {
    const short = shortLifetime(job, issuer, check.lifetimeDays);
    if (short) say(`${out.mark(false)} ${short}`);
    if (reset)
      say(`\n${resetStop(deps, issuer, reset, vaultName(entry.ref, deps.vaults), job.args)}`);
    if (short || reset) return 1;
    say(`${out.mark(true)} ${key.name} (${owner.environment}) is ready for keypin rotate --due.`);
    return 0;
  }
  const ready: Ready = {
    ids: read.ids,
    pairIds: read.pair?.ids ?? null,
    issuer,
    checked,
    pairChecked: pairChecks(job, checked),
    removed: [...removed, ...(pairNow?.removed ?? [])],
  };
  if (next.action === "resume" && check.gone !== undefined) {
    if (job.approve) {
      say(`\nStopped: ${check.gone}. Nothing was revoked.`);
      return 1;
    }
    if (!(await vaultTakesWrites(job))) return 1;
    oldStays(job, issuer, next.issued);
    next = { action: "create", current: null, abandoned: null };
  }
  if (job.discard && next.action === "resume") {
    const dropped = next.issued;
    if (issuer.createResetsOld && waitsForRevoke(dropped) && dropped.old.id !== null) {
      say(
        `\nStopped: ${issuer.describe()} makes a new key by resetting key ${shown(issuer, dropped.old.id)}, the one key ${shown(issuer, dropped.id)} replaced, and a destination may still use it. Finish this rotation, then run it again to replace key ${shown(issuer, dropped.id)}:\n  ${commandLine(deps, "rotate", withoutDiscard(job.args))}\nNothing was created.`,
      );
      return 1;
    }
    if (!(await vaultTakesWrites(job))) return 1;
    say(
      out.dim(
        `\nDiscarding key ${shown(issuer, dropped.id)}, which keypin created at ${issuer.describe()} on ${dropped.at}: a new key replaces it everywhere.`,
      ),
    );
    oldStays(job, issuer, dropped);
    next = { action: "create", current: dropped.id, abandoned: null };
  }
  if (next.action === "resume") {
    const pairSteps = (await pairPlan(new Secret(next.issued.id)))?.steps ?? [];
    const writes = { steps: unpublished, pairSteps, idSaved };
    return resume(job, ready, next.issued, read.secret, writes, state);
  }

  const orphan =
    job.pair && next.abandoned && neverSaved(next.abandoned, spec, generation, state)
      ? next.abandoned
      : null;
  const note =
    next.abandoned && !orphan
      ? abandonedNote(next.abandoned, issuer, spec, vaultName(entry.ref, deps.vaults))
      : null;
  if (note !== null) say(`\n${out.dim(note)}`);
  const known = job.pair ? check.currentId : (next.current ?? check.currentId);
  const current = check.gone === undefined ? (known ?? null) : null;
  const steps = planNewValue(input, read.ids);
  const pairSteps = pairInput ? planNewValue(pairInput, read.pair?.ids ?? null) : [];
  const readers = await readerRows(job);
  say("\nPlan");
  showPlan(out, [
    ...(orphan
      ? [
          row(
            "-",
            issuer.describe(),
            `revoke key ${shown(issuer, orphan.id)}, which keypin created on ${orphan.at} but never saved`,
          ),
        ]
      : []),
    row("+", issuer.describe(), "create a new key", check.notes?.create),
    row(
      "~",
      vaultName(entry.ref, deps.vaults),
      `save it to ${formatReference(entry.ref, deps.vaults)}, rotated today`,
    ),
    ...(job.pair ? [saveIdRow(job, job.pair)] : []),
    ...writeRows(job, steps, pairSteps),
    ...readers,
    !issuer.revoke
      ? row("=", issuer.describe(), "nothing to revoke: the new value replaces the old one")
      : check.gone === undefined
        ? revokeRow(issuer, current, revokeWhen(job, "after a second y"), check.notes?.revoke)
        : row("=", issuer.describe(), `nothing to revoke: ${check.gone}`),
  ]);
  showRemoved(out, ready.removed);
  const unread = unreadNote(job, readers);
  if (unread !== null) say(`\n${unread}`);
  apartNote(job, checked);
  const needsApproval =
    reset !== null || [...steps, ...pairSteps].some((step) => step.approval !== null);
  if (job.plan)
    return planOnly(deps, "rotate", reset ? terminalArgs(job.args) : job.args, needsApproval);
  if (job.yes && reset) {
    say(`\n${resetStop(deps, issuer, reset, vaultName(entry.ref, deps.vaults), job.args)}`);
    return 1;
  }
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

  if (orphan && !(await revokeOrphan(job, issuer, orphan.id))) return 1;
  const created = await createKey(job, issuer);
  if ("unchanged" in created) {
    if (created.unchanged) say("Stopped. Nothing was created.");
    else mayHaveCreated(job, issuer, created.name);
    return 1;
  }
  job = { ...job, discard: false, args: withoutDiscard(job.args) };
  const issued: Issued = {
    ...owner,
    issuer: spec.kind,
    id: created.id,
    generation: await generationOf(created.secret),
    at: deps.now().toISOString(),
    old: issuer.revoke
      ? { id: current, generation, revoked: check.gone !== undefined }
      : { id: null, generation, revoked: true },
  };
  const mayHold = vaultKindOf(deps.vaults, entry.ref.kind).holdsWrites === true;
  const pending = mayHold ? { ...issued, held: true } : issued;
  try {
    await saveState(deps.files, job.path, recordIssued(state, pending));
  } catch (error) {
    return undoCreate(
      job,
      issuer,
      created.id,
      `couldn't record the new key in ${job.path}: ${messageOf(error)}`,
    );
  }

  const saved = await saveKey(job, entry.ref, created.secret, "the new key");
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
    await saveState(deps.files, job.path, recordIssued(state, { ...pending, unsaved: true }));
    const vault = vaultName(entry.ref, deps.vaults);
    say(
      `Stopped: keypin can't tell whether ${vault} saved the new key ${shown(issuer, created.id)}. Run this again, and keypin picks up from what ${vault} holds:\n  ${commandLine(deps, "rotate", job.args)}`,
    );
    return 1;
  }
  if (job.pair && !(await saveId(job, job.pair, issuer, created.id))) return 1;
  const ids = await itemIdsAfterSave(job);
  if (!ids) return 1;
  return publishThenRevoke(
    job,
    { ...ready, ...ids },
    issued,
    created.secret,
    { steps, pairSteps, idSaved: true },
    state,
  );
}
