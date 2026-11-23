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
import { type Flags, type Context, jobFor } from "./job";
import { rotateLocked } from "./rotate-key";
import { waitsNotice } from "./messages";

async function progressOf(
  context: Context,
  path: string,
  { only, check = false }: { only?: string | undefined; check?: boolean } = {},
) {
  const { map, environment, committed, deps } = context;
  const state = restoreIssued(await loadState(deps.files, path, deps.vaults), committed, map);
  const progress = new Map<string, Progress>();
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
    const holds = await vaultGeneration(context, key, entry, state, check);
    if (holds !== null && holds !== issued.generation && holds !== issued.old.generation) continue;
    const vaultOnly = entry.publish.length === 0;
    const rolledBack = vaultOnly && holds === issued.old.generation && !issued.unsaved;
    if (rolledBack) continue;
    const neverSaved = vaultOnly && holds !== issued.generation && issued.unsaved === true;
    progress.set(key.name, { kind: neverSaved ? "unfinished" : kind, since, revokes });
  }
  return (keyId: string): Progress => progress.get(keyId) ?? null;
}

async function vaultGeneration(
  context: Context,
  key: KeyEntry,
  entry: EnvEntry,
  state: State,
  check: boolean,
): Promise<string | null> {
  const { deps, out } = context;
  const gated = check || !deps.isTerminal;
  if (gated && !(await readsRoutinely(context, key, entry, state))) return null;
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
  const choices = dueKeys({
    map,
    environment,
    today: localDay(deps.now()),
    metadata: (ref) => metadata.dates.get(refKey(ref)) ?? null,
    progress: await progressOf(context, path),
  });
  const shown = { rotate: "rotate", finish: "finish", skip: "skip", waiting: "wait" } as const;
  out.line(`\nKeys in ${environment}`);
  const rows = columns(choices.map((c) => [c.keyId, shown[c.action]]));
  choices.forEach((c, i) => out.line(`  ${(rows[i] ?? []).join("  ")}  ${out.dim(c.why)}`));
  const picked = choices.filter((c) => c.action === "rotate" || c.action === "finish");
  const waiting = choices.filter((c) => c.action === "waiting");
  if (!picked.length)
    out.line(waiting.length ? "Nothing is due. An old key waits for approval." : "Nothing is due.");
  for (const c of waiting) waitsNotice(context, c.keyId);
  if (!picked.length) return 0;
  const codes: number[] = [];
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

export async function checkDue(context: Context, path: string): Promise<number> {
  const { map, environment, deps, out } = context;
  const metadata = await readDates(deps, dueRefs(map, environment));
  const choices = dueKeys({
    map,
    environment,
    today: localDay(deps.now()),
    metadata: (ref) => metadata.dates.get(refKey(ref)) ?? null,
    progress: await progressOf(context, path, { check: true }),
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
  const codes: number[] = [];
  for (const choice of picked) {
    out.line("");
    const key = map.keys.find((each) => each.name === choice.keyId);
    const ref = key?.environments[environment]?.ref;
    const read = ref !== undefined && metadata.dates.get(refKey(ref)) != null;
    const undated = read && vaultKindOf(deps.vaults, ref.kind).keepsRotated === false;
    if (key?.rotateEvery?.days != null && undated) {
      const { keyId } = choice;
      out.line(
        `${out.mark(false)} ${keyId} (${environment}): its vault keeps no rotation date, so scheduled rotation can't cover it. rotate_every applies to ${keyId} in every profile, so either set it to "never" (or remove it) in every [tool.keypin.<profile>.${keyId}] that sets it, which stops scheduled rotation of ${keyId} in every profile, or keep its ${environment} value in a vault that keeps rotation dates. Rotate it by hand with keypin rotate ${keyId} --profile ${environment}.`,
      );
      codes.push(1);
      continue;
    }
    if (choice.action === "skip" && choice.date === "missing") {
      out.line(
        `${out.mark(false)} ${choice.keyId}: ${choice.why}, so keypin rotate --due never rotates it. Give its vault item a rotated date: the day the key last changed.`,
      );
      codes.push(1);
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
  const code = worst(codes);
  out.line(
    code === 0
      ? `\n${out.mark(true)} Every key --due rotates passed the checks. Nothing was created or written, so no destination was asked to take a write.`
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
