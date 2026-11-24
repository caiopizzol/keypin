import {
  deliveredTo,
  type DueChoice,
  dueKeys,
  dueRefs,
  type Progress,
  restoreIssued,
  restoreReceipts,
  rotates,
  waitsForRevoke,
  approvalsFor,
  type EnvEntry,
  formatReference,
  generationOf,
  issuedFor,
  type KeyEntry,
  type KeyRef,
  localDay,
  loadState,
  messageOf,
  type State,
  vaultKindOf,
} from "@keypin/core";
import { columns } from "../../output";
import { refKey } from "../../vault";
import { readDates } from "../status";
import { approval } from "../../sign-in";
import { NEEDS_APPROVAL } from "../../approval";
import { lookUpIds } from "../../publishing";
import { type Flags, type Context, jobFor, keepsNoDates } from "./job";
import { rotateLocked } from "./rotate-key";
import { waitsNotice } from "./messages";
import { checkCredentials, type MayRead } from "./credentials";

const GATED = Symbol("gated");

async function progressOf(
  context: Context,
  path: string,
  { only, check = false }: { only?: string | undefined; check?: boolean } = {},
) {
  const { map, environment, committed, deps } = context;
  const state = restoreIssued(await loadState(deps.files, path, deps.vaults), committed, map);
  const progress = new Map<string, Progress>();
  const unverified = new Set<string>();
  const unreadable = new Set<string>();
  for (const key of map.keys) {
    if (only !== undefined && key.name !== only) continue;
    const entry = rotates(map, key.name, environment);
    const owner = { keyId: key.name, environment, mapFile: map.file };
    const issued = issuedFor(state, owner);
    if (!entry || !issued) continue;
    const everywhere = entry.publish.every((target) =>
      deliveredTo(committed, state.receipts, owner, target, issued.generation, deps.destinations),
    );
    const since = issued.at.slice(0, 10);
    const revokes = waitsForRevoke(issued);
    const kind = !everywhere || issued.held ? "unfinished" : revokes ? "waiting" : null;
    if (kind === null) continue;
    if (issued.held) {
      progress.set(key.name, { kind, since, revokes });
      continue;
    }
    const read = await vaultGeneration(context, key, entry, state, check);
    const holds = typeof read === "string" ? read : null;
    if (read === GATED) unverified.add(key.name);
    else if (read === null) unreadable.add(key.name);
    if (holds !== null && holds !== issued.generation && holds !== issued.old.generation) continue;
    const vaultOnly = entry.publish.length === 0;
    const rolledBack = vaultOnly && holds === issued.old.generation && !issued.unsaved;
    if (rolledBack) continue;
    const neverSaved = vaultOnly && holds !== issued.generation && issued.unsaved === true;
    progress.set(key.name, { kind: neverSaved ? "unfinished" : kind, since, revokes });
  }
  return Object.assign((keyId: string): Progress => progress.get(keyId) ?? null, {
    unverified,
    unreadable,
  });
}

async function vaultGeneration(
  context: Context,
  key: KeyEntry,
  entry: EnvEntry,
  state: State,
  check: boolean,
): Promise<string | typeof GATED | null> {
  const { deps, out } = context;
  const gated = check || !deps.isTerminal;
  if (gated && !(await readsRoutinely(context, key, entry, state))) return GATED;
  const where = formatReference(entry.ref, deps.vaults);
  const read = await out.step(
    `Reading the key ${where}`,
    () =>
      deps
        .vault()
        .read(entry.ref)
        .then(generationOf)
        .then(
          (generation) => ({ generation }),
          (error: unknown) => ({ failed: messageOf(error) }),
        ),
    (result) => ({
      ok: "generation" in result,
      text: "generation" in result ? `Read the key ${where}` : `Couldn't read ${where}`,
    }),
    approval(deps, [entry.ref]),
  );
  if (!("generation" in read)) {
    out.line(`    ${read.failed}`);
    return null;
  }
  return read.generation;
}

async function readsRoutinely(
  { map, environment, committed, deps, out }: Context,
  key: KeyEntry,
  entry: EnvEntry,
  state: State,
): Promise<boolean> {
  const owner = { keyId: key.name, environment, mapFile: map.file };
  try {
    const [ids] = await lookUpIds([entry.ref], deps, out);
    if (!ids) return false;
    const { receipts } = await restoreReceipts({
      state,
      file: committed,
      map,
      kinds: deps.destinations,
      owner,
      ids: async () => ids,
    });
    const input = { kinds: deps.destinations, vaults: deps.vaults, key, receipts, ...owner };
    return approvalsFor(input, ids).length === 0;
  } catch (error) {
    out.line(`    ${messageOf(error)}`);
    return false;
  }
}

export async function rotateDue(context: Context, flags: Flags, path: string): Promise<number> {
  const { map, environment, deps, out } = context;
  const metadata = await readDates(deps, dueRefs(map, environment));
  const dated = (ref: KeyRef) => metadata.dates.get(refKey(ref)) ?? null;
  const choices = dueKeys({
    map,
    environment,
    today: localDay(deps.now()),
    metadata: dated,
    progress: await progressOf(context, path),
  });
  const shown = { rotate: "rotate", finish: "finish", skip: "skip", waiting: "wait" } as const;
  out.line(`\nKeys in ${environment}`);
  const rows = columns(choices.map((c) => [c.keyId, shown[c.action]]));
  choices.forEach((c, i) => out.line(`  ${(rows[i] ?? []).join("  ")}  ${out.dim(c.why)}`));
  const picked = choices.filter((c) => c.action === "rotate" || c.action === "finish");
  const waiting = choices.filter((c) => c.action === "waiting");
  const blocked = waiting.filter((c) => c.blocked !== undefined);
  const codes: number[] = [];
  for (const choice of choices) {
    const problem = undatedProblem(context, choice);
    if (problem === null) continue;
    out.line(`${out.mark(false)} ${problem}`);
    codes.push(1);
  }
  for (const c of blocked) out.line(`${out.mark(false)} ${blockedText(context, c)}`);
  if (blocked.length) codes.push(NEEDS_APPROVAL);
  if (!picked.length && !blocked.length)
    out.line(waiting.length ? "Nothing is due. An old key waits for approval." : "Nothing is due.");
  for (const c of waiting) waitsNotice(context, c.keyId);
  const gated = !deps.isTerminal && !flags.plan;
  codes.push(await checkCredentials(context, choices, dated, adminGate(context, path, gated)));
  for (const choice of picked) {
    out.line("");
    try {
      const args = [choice.keyId, ...context.envArgs, ...(flags.yes ? ["--yes"] : [])];
      codes.push(
        await rotateLocked({ ...jobFor(context, choice.keyId, { ...flags, args }), path }),
      );
    } catch (error) {
      out.line(`${choice.keyId}: ${messageOf(error)}`);
      codes.push(1);
    }
  }
  return worst(codes);
}

function readRefs(map: Context["map"], environment: string): KeyRef[] {
  return map.keys.flatMap((key) => {
    const entry = key.environments[environment];
    return entry?.issuer ? [entry.ref, ...(entry.issuer.admin ? [entry.issuer.admin] : [])] : [];
  });
}

export async function checkDue(context: Context, path: string): Promise<number> {
  const { map, environment, deps, out } = context;
  const metadata = await readDates(deps, dueRefs(map, environment));
  const dated = (ref: KeyRef) => metadata.dates.get(refKey(ref)) ?? null;
  const progress = await progressOf(context, path, { check: true });
  const choices = dueKeys({
    map,
    environment,
    today: localDay(deps.now()),
    metadata: dated,
    progress,
  });
  const checks = (c: DueChoice) => c.action !== "skip" || c.date !== undefined;
  out.line(`\nKeys in ${environment}`);
  const rows = columns(choices.map((c) => [c.keyId, checks(c) ? "check" : "skip"]));
  choices.forEach((c, i) => out.line(`  ${(rows[i] ?? []).join("  ")}  ${out.dim(c.why)}`));
  const picked = choices.filter(checks);
  if (!picked.length) {
    out.line(
      `\nNothing to check: no key in ${environment} has an issuer and rotate_every. See docs/reference/secretspec-toml.md.`,
    );
    return 1;
  }
  const codes = [await checkCredentials(context, choices, dated, adminGate(context, path, true))];
  for (const choice of picked) {
    out.line("");
    const key = map.keys.find((each) => each.name === choice.keyId);
    const ref = key?.environments[environment]?.ref;
    const read = ref !== undefined && metadata.dates.get(refKey(ref)) != null;
    const keepsNoDate = read && vaultKindOf(deps.vaults, ref.kind).keepsRotated === false;
    if (key?.rotateEvery?.days != null && keepsNoDate) {
      const { keyId } = choice;
      out.line(
        `${out.mark(false)} ${keyId} (${environment}): its vault keeps no rotation date, so scheduled rotation can't cover it. rotate_every applies to ${keyId} in every profile, so either set it to "never" (or remove it) in every [tool.keypin.<profile>.${keyId}] that sets it, which stops scheduled rotation of ${keyId} in every profile, or keep its ${environment} value in a vault that keeps rotation dates. Rotate it by hand with keypin rotate ${keyId} --profile ${environment}.`,
      );
      codes.push(1);
      continue;
    }
    const problem = undatedProblem(context, choice);
    if (problem !== null) {
      out.line(`${out.mark(false)} ${problem}`);
      codes.push(1);
      continue;
    }
    if (choice.action === "waiting" && progress.unreadable.has(choice.keyId)) {
      out.line(
        `${out.mark(false)} ${choice.keyId} (${environment}): keypin couldn't read its vault item, so it can't tell whether its old key still waits for approval. Run the check again; if it keeps failing, fix the vault read first.`,
      );
      codes.push(1);
      continue;
    }
    const verified = !progress.unverified.has(choice.keyId);
    if (choice.action === "waiting" && choice.blocked !== undefined && verified) {
      out.line(`${out.mark(false)} ${blockedText(context, choice)}`);
      waitsNotice(context, choice.keyId);
      codes.push(NEEDS_APPROVAL);
      continue;
    }
    try {
      const args = [choice.keyId, ...context.envArgs];
      const flags = { ...NO_FLAGS, plan: true, check: true, args };
      codes.push(await rotateLocked({ ...jobFor(context, choice.keyId, flags), path }));
    } catch (error) {
      out.line(`${out.mark(false)} ${choice.keyId}: ${messageOf(error)}`);
      codes.push(1);
    }
  }
  for (const note of (await deps.vault().notes?.(readRefs(map, environment))) ?? [])
    out.line(`\n${out.dim(`Note: ${note}`)}`);
  const code = worst(codes);
  out.line(
    code === 0
      ? `\n${out.mark(true)} Every key --due rotates passed the checks. Nothing was created or written, so no destination was asked to take a write.`
      : code === NEEDS_APPROVAL
        ? "\nApprove what waits above, then run the check again. Nothing was created or written."
        : "\nFix what failed above, then run the check again. Nothing was created or written.",
  );
  return code;
}

export async function approveAll(
  context: Context,
  keyId: string | undefined,
  path: string,
): Promise<number> {
  const { map, environment, out } = context;
  if (keyId !== undefined) jobFor(context, keyId, NO_FLAGS);
  const progress = await progressOf(context, path, { only: keyId });
  const codes: number[] = [];
  for (const name of keyId === undefined ? map.keys.map((k) => k.name) : [keyId]) {
    const now = progress(name);
    if (now?.kind === "unfinished" && now.revokes) {
      out.line(
        `Stopped: not every destination has the new ${name} (${environment}) yet, so keypin won't revoke the old key. Run keypin rotate --due first. Nothing was revoked.`,
      );
      codes.push(1);
    } else if (now?.kind === "waiting") {
      const args = [name, ...context.envArgs, "--approve-revoke"];
      out.line("");
      codes.push(
        await rotateLocked({
          ...jobFor(context, name, { ...NO_FLAGS, approve: true, args }),
          path,
        }),
      );
    } else if (keyId !== undefined) {
      out.line(
        `Stopped: ${name} (${environment}) has no old key waiting for approval. Nothing was revoked.`,
      );
      codes.push(1);
    }
  }
  if (!codes.length) out.line(`No old key waits for approval in ${environment}.`);
  return worst(codes);
}

function blockedText({ environment, deps }: Context, choice: DueChoice & { action: "waiting" }) {
  const when =
    choice.blocked === localDay(deps.now()) ? "is due today" : `was due ${choice.blocked}`;
  return `${choice.keyId} (${environment}) ${when}, but keypin won't rotate it while its old key waits for approval.`;
}

function adminGate(context: Context, path: string, gated: boolean): MayRead {
  const { map, committed, deps } = context;
  let state: Promise<State> | undefined;
  return async (keyId, entry) => {
    if (!gated || !entry.publish.length) return true;
    const key = map.keys.find((each) => each.name === keyId);
    if (!key) return false;
    state ??= loadState(deps.files, path, deps.vaults).then((s) =>
      restoreIssued(s, committed, map),
    );
    return readsRoutinely(context, key, entry, await state);
  };
}

function undated(choice: DueChoice): boolean {
  return (
    (choice.action === "skip" || choice.action === "waiting") &&
    (choice.date === "missing" || choice.date === "unread")
  );
}

function undatedProblem(context: Context, choice: DueChoice): string | null {
  if (!undated(choice)) return null;
  if ("date" in choice && choice.date === "unread")
    return `${choice.keyId}: the vault's rotated date couldn't be read, so keypin can't tell when it's due. Fix the error above, then run this again.`;
  if (keepsNoDates(context, choice.keyId)) return null;
  return `${choice.keyId}: no rotated date in the vault, so keypin rotate --due never rotates it. Give its vault item a rotated date: the day the key last changed.`;
}

const NO_FLAGS: Flags = {
  yes: false,
  plan: false,
  due: false,
  approve: false,
  check: false,
  discard: false,
  args: [],
};

function worst(codes: readonly number[]): number {
  return codes.includes(1) ? 1 : codes.includes(NEEDS_APPROVAL) ? NEEDS_APPROVAL : 0;
}
