import {
  removedBehind,
  generationOf,
  proves,
  RevokeRefused,
  type Issued,
  messageOf,
  type PlanStep,
  recordIssued,
  saveState,
  Secret,
  type State,
  vaultName,
} from "@keypin/core";
import { confirm } from "../../output";
import { ROTATION_FILE } from "../../project";
import { commandLine, confirmed, NEEDS_APPROVAL, planOnly } from "../../approval";
import { showPlan, showRemoved, writeEach, writesFor } from "../../publishing";
import { type Job, type Ready } from "./job";
import { saveId, itemIdsAfterSave } from "./vault-and-issuer";
import {
  revokeRow,
  revokeWhen,
  saveIdRow,
  writeRows,
  shown,
  apartNote,
  reached,
  revokeRefused,
  waitsNotice,
} from "./messages";

interface Writes {
  steps: PlanStep[];
  pairSteps: PlanStep[];
  idSaved: boolean;
}

export async function resume(
  job: Job,
  ready: Ready,
  issued: Issued,
  secret: Secret,
  writes: Writes,
  state: State,
): Promise<number> {
  const { out, deps, pair } = job;
  out.line(
    `\nResuming: keypin created key ${shown(ready.issuer, issued.id)} at ${ready.issuer.describe()} on ${issued.at}, and ${vaultName(job.entry.ref, job.deps.vaults)} holds it.`,
  );
  const { steps, pairSteps } = writes;
  const unsavedId = pair !== null && !writes.idSaved;
  const all = [...steps, ...pairSteps];
  const published = all.every((step) => step.action === "skip") && !unsavedId;
  if (published && !job.plan) return revokeOld(job, ready, issued, secret, state);
  const old = issued.old.revoked ? null : issued.old.id;
  out.line("\nPlan");
  showPlan(out, [
    ...(pair && unsavedId ? [saveIdRow(job, pair)] : []),
    ...writeRows(job, steps, pairSteps),
    ...(old === null
      ? []
      : [
          revokeRow(
            ready.issuer,
            old,
            revokeWhen(job, published ? "after a y" : "after a second y"),
          ),
        ]),
  ]);
  showRemoved(out, ready.removed);
  apartNote(job, ready.checked);
  const needsApproval = published || all.some((step) => step.approval !== null);
  if (job.plan) return planOnly(deps, "rotate", job.args, needsApproval);
  out.line("");
  const total =
    writesFor(steps, ready.checked).length +
    writesFor(pairSteps, ready.pairChecked).length +
    (unsavedId ? 1 : 0);
  const ok = await confirmed(deps, {
    yes: job.yes,
    args: job.args,
    command: "rotate",
    needsApproval,
    question: `Write ${total} secret${total === 1 ? "" : "s"}?`,
  });
  if (!ok) return NEEDS_APPROVAL;
  if (pair && unsavedId) {
    if (!(await saveId(job, pair, ready.issuer, issued.id))) return 1;
    const ids = await itemIdsAfterSave(job);
    if (!ids) return 1;
    return publishThenRevoke(job, { ...ready, ...ids }, issued, secret, writes, state);
  }
  return publishThenRevoke(job, ready, issued, secret, writes, state);
}

export async function publishThenRevoke(
  job: Job,
  ready: Ready,
  issued: Issued,
  secret: Secret,
  { steps, pairSteps }: Writes,
  state: State,
): Promise<number> {
  const { key, entry, owner, pair, deps, out } = job;
  const place = { environment: owner.environment, mapFile: owner.mapFile };
  const jobs = [
    {
      ...place,
      key,
      entry,
      secret,
      ids: ready.ids,
      generation: issued.generation,
      writes: writesFor(steps, ready.checked),
    },
  ];
  if (pair && ready.pairIds) {
    const id = new Secret(issued.id);
    jobs.push({
      ...place,
      key: pair.key,
      entry: pair.entry,
      secret: id,
      ids: ready.pairIds,
      generation: await generationOf(id),
      writes: writesFor(pairSteps, ready.pairChecked),
    });
  }
  const written = await writeEach(jobs, { state, path: job.path, deps, out, label: job.label });
  if (!written.ok) {
    out.line(
      `Stopped. The new key is in ${vaultName(entry.ref, deps.vaults)}, and the old key still works. To continue, run:\n  ${commandLine(deps, "rotate", job.args)}`,
    );
    return 1;
  }
  return revokeOld(job, ready, issued, secret, written.state);
}

async function revokeOld(
  job: Job,
  ready: Ready,
  issued: Issued,
  current: Secret,
  state: State,
): Promise<number> {
  const { key, owner, deps, out } = job;
  const { issuer } = ready;
  const where = issuer.describe();
  out.line(`\nRotated ${out.bold(key.name)} (${owner.environment}): ${reached(job)}`);
  const recorded = removedBehind(
    job.committed,
    job.map,
    deps.destinations,
    owner,
    issued.generation,
  )
    .filter((p) => !ready.removed.some((r) => r.destinationId === p.destination))
    .map((p) => ({
      destinationId: p.destination,
      lastReceipt: { generation: p.generation, at: p.at, destinationAccount: "unknown" },
    }));
  const behind = [
    ...ready.removed.filter((r) => r.lastReceipt.generation !== issued.generation),
    ...recorded,
  ];
  if (behind.length) {
    out.line(
      "Not in secretspec.toml any more, so keypin didn't write them; they may still use the old key:",
    );
    showRemoved(out, behind);
  }
  const old = issued.old.id;
  const revoke = issuer.revoke?.bind(issuer);
  if (!revoke) {
    out.line(`Nothing to revoke: the old value stops working once your apps use the new one.`);
    return 0;
  }
  if (issued.old.revoked) return 0;
  if (old === null) {
    out.line(
      `keypin doesn't know which key at ${where} it replaced. Once nothing uses the old one, delete it at ${issuer.dashboard()}.`,
    );
    return 0;
  }
  if (old === issued.id) {
    out.line(revokeRefused(issuer, old, "it's the key the vault holds"));
    return 1;
  }
  const asked = job.args.filter((arg) => arg !== "--yes");
  const later = `To revoke it later, run this in a terminal:\n  ${commandLine(deps, "rotate", asked)}`;
  if (job.due && !deps.isTerminal) {
    out.line(`The old key ${shown(issuer, old)} still works, and waits for approval.`);
    waitsNotice({ ...job, environment: owner.environment }, key.name);
    return 0;
  }
  const proof = await proves(issued, current, "new");
  if (proof === false) {
    out.line(
      revokeRefused(
        issuer,
        old,
        "keypin's record of this rotation doesn't match the vault's value",
      ),
    );
    return 1;
  }
  if (proof === undefined && !deps.isTerminal) {
    out.line(
      `Stopped: ${ROTATION_FILE} doesn't prove this rotation replaced key ${shown(issuer, old)}, because an older keypin recorded it, so keypin won't revoke it without a terminal. Nothing was revoked. Once nothing uses it, run this in a terminal:\n  ${commandLine(deps, "rotate", asked)}`,
    );
    return 1;
  }
  if (job.approve && !deps.isTerminal && behind.length) {
    out.line(
      `Stopped: something no longer in secretspec.toml may still use the old key ${shown(issuer, old)}, so keypin won't revoke it without a terminal. Nothing was revoked. Once nothing uses it, run this in a terminal:\n  ${commandLine(deps, "rotate", asked)}`,
    );
    return 1;
  }
  if (!deps.isTerminal && !job.approve) {
    out.line(
      `The old key ${shown(issuer, old)} still works. Revoking it needs a y in a terminal.\n${later}`,
    );
    return NEEDS_APPROVAL;
  }
  if (proof === undefined)
    out.line(
      `${ROTATION_FILE} doesn't prove this rotation replaced key ${shown(issuer, old)}: check it's the old key before you revoke it.`,
    );
  if (!job.approve || behind.length || proof === undefined) {
    out.line(`The old key ${shown(issuer, old)} still works. Revoke it once nothing uses it.`);
    if (!(await confirm(deps, `Revoke the old key at ${where}?`))) {
      out.line(later);
      return 0;
    }
  }
  try {
    await out.step(
      `${where}  revoking ${shown(issuer, old)}`,
      () => revoke(old, current),
      (result) => ({
        ok: true,
        text: `${where}  ${result === "revoked" ? "revoked" : "already gone:"} ${shown(issuer, old)}`,
      }),
    );
  } catch (error) {
    if (error instanceof RevokeRefused) {
      out.line(revokeRefused(issuer, old, error.message));
      return 1;
    }
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
