import { parseArgs } from "node:util";
import {
  addDays,
  approvalsFor,
  destinationId,
  DUE_SOON_DAYS,
  dropRotation,
  type EnvEntry,
  type Environment,
  ENVIRONMENTS,
  generationOf,
  type IssueSpec,
  type KeyEntry,
  loadRotations,
  loadState,
  periodDays,
  planPublish,
  type ProviderToken,
  putRotation,
  type Rotation,
  type Rotations,
  sameAccess,
  saveRotations,
  type Secret,
  type TokenProvider,
  unfinishedRotation,
} from "@keypin/core";
import { type Deps, localDay, UsageError } from "../deps";
import { messageOf } from "../errors";
import { rotationsPath } from "../paths";
import { findMap } from "../project";
import {
  accountFacts,
  type Checked,
  checkAccounts,
  describeTarget,
  locked,
  NEEDS_APPROVAL,
  rerun,
  type Say,
  writeAll,
  writesFor,
} from "../publishing";
import { announce } from "../vault";

const GRACE_DAYS = DUE_SOON_DAYS;

interface Run {
  key: KeyEntry;
  entry: EnvEntry;
  issue: IssueSpec;
  environment: Environment;
  yes: boolean;
  args: string[];
  statePath: string;
  rotationsPath: string;
  deps: Deps;
  say: Say;
}

export async function rotate(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      env: { type: "string", default: "prod" },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [keyId, ...extra] = positionals;
  if (keyId === undefined || extra.length) throw new UsageError("keypin rotate takes one key ID");
  const environment = ENVIRONMENTS.find((name) => name === values.env);
  if (!environment) {
    throw new UsageError(`--env is ${ENVIRONMENTS.join(" or ")}, got "${values.env}"`);
  }

  const map = await findMap(deps.files, deps.cwd);
  const key = map.keys.find((k) => k.id === keyId);
  if (!key) throw new Error(`${map.file} has no key "${keyId}"`);
  const entry = key.environments[environment];
  if (!entry) throw new Error(`key "${keyId}" has no ${environment} entry in ${map.file}`);
  const issue = entry.issue;
  if (!issue) {
    throw new Error(
      `key "${keyId}" has no [keys.${keyId}.${environment}.issue] section in ${map.file}, so keypin can't make a new value`,
    );
  }

  const say: Say = (text) => deps.stderr.write(`${text}\n`);
  return locked(deps, async (statePath) => {
    const run: Run = {
      key,
      entry,
      issue,
      environment,
      yes: values.yes,
      args,
      statePath,
      rotationsPath: rotationsPath(deps),
      deps,
      say,
    };
    const data = await loadRotations(deps.files, run.rotationsPath);
    const open = unfinishedRotation(data, key.id, environment);
    if (!open) return start(run, data);
    say(
      `An unfinished rotation of ${key.id} (${environment}), started ${open.startedAt}, is at stage "${open.stage}".`,
    );
    switch (open.stage) {
      case "issuing":
      case "issued":
        return abandon(run, data, open);
      case "stored":
        return publishNew(run, data, open, null);
      case "published":
        return revokeOld(run, data, open);
      case "revoked":
        throw new Error(`rotation ${open.id} is finished`);
    }
  });
}

async function start(run: Run, data: Rotations): Promise<number> {
  const { key, entry, issue, environment, deps, say } = run;
  say(`Rotating ${key.id} (${environment}) as ${key.env}, item "${entry.ref.item}"`);
  say(`  vault: 1Password account ${entry.ref.account}, vault "${entry.ref.vault}"`);
  say(
    `  new token: ${issue.provider} in account ${issue.account}, made with the admin token in item "${issue.admin.item}"`,
  );
  for (const target of entry.publish) say(`  to: ${describeTarget(target, key.env)}`);

  const state = await loadState(deps.files, run.statePath);
  const checked = await checkAccounts(key, entry, deps, say);
  if (!checked) {
    say("Stopped: an account check failed. Nothing was read and nothing was changed.");
    return 1;
  }
  const approvals = approvalsFor({ key, environment, receipts: state.receipts });
  if (!deps.isTerminal && (approvals.length || !run.yes)) {
    for (const approval of approvals) say(`  needs approval: ${approval.approval}`);
    say(
      approvals.length
        ? "Stopped before reading anything: this rotation needs approval, and --yes can't give it. Nothing was changed."
        : "Stopped before reading anything: no terminal to confirm on. Nothing was changed. Add --yes, or confirm in a terminal.",
    );
    say(rerun(deps, "rotate", run.args));
    return NEEDS_APPROVAL;
  }

  announce(deps.stderr, "the current value, its rotation fields and the admin token", [
    entry.ref,
    issue.admin,
  ]);
  const vault = deps.vault();
  let current: Secret;
  let admin: Secret;
  let every: string | null;
  try {
    current = await vault.read(entry.ref);
    every = key.rotateEvery ?? (await vault.metadata(entry.ref)).rotateEvery;
    admin = await vault.read(issue.admin);
  } catch (error) {
    say(`Stopped: ${messageOf(error)}. Nothing was changed.`);
    return 1;
  }
  const days = periodDays(every);
  if (!days) {
    say(
      `Stopped: rotate needs a rotation period to set the new token's expiry, and rotate_every is ${every ? `"${every}"` : "missing"}. Nothing was changed.`,
    );
    return 1;
  }

  const provider = deps.provider(issue, admin);
  const found = await provider.verify(current);
  if (found.status !== "active") {
    say(
      `Stopped: the current value is token ${found.id}, and it's ${found.status}. Nothing was changed.`,
    );
    return 1;
  }
  const old = await provider.details(found.id);
  if (!old) {
    say(
      `Stopped: the admin token can't read token ${found.id}, the current value's token. Nothing was changed.`,
    );
    return 1;
  }

  const today = localDay(deps.now());
  const name = nextName(old.name, today);
  const expiresOn = `${addDays(today, days + GRACE_DAYS)}T23:59:59Z`;
  say("\nPlan:");
  say(
    `  current token: ${old.id} "${old.name}", ${old.status}, expires ${old.expiresOn ?? "never"}`,
  );
  say(
    `  new token: "${name}", expires ${expiresOn} (rotate_every ${every} plus ${GRACE_DAYS} days' grace)`,
  );
  for (const line of describeAccess(old)) say(`    ${line}`);
  say(`  store in: item "${entry.ref.item}", with rotated ${today}`);
  for (const target of entry.publish) {
    const found = checked.get(destinationId(target, key.env));
    say(`  publish to: ${describeTarget(target, key.env)}`);
    if (found) say(`    ${accountFacts(found.check)}`);
  }
  for (const approval of approvals) say(`    needs approval: ${approval.approval}`);
  say(`  then stop: the old token stays active until you run keypin rotate ${key.id} again.`);

  if (!(await confirmed(run, approvals.length > 0, "make the new token"))) return NEEDS_APPROVAL;

  const now = deps.now().toISOString();
  let rotation: Rotation = {
    id: crypto.randomUUID(),
    keyId: key.id,
    environment,
    item: entry.ref,
    provider: issue.provider,
    account: issue.account,
    stage: "issuing",
    startedAt: now,
    updatedAt: now,
    old: {
      id: old.id,
      name: old.name,
      expiresOn: old.expiresOn,
      generation: await generationOf(current),
    },
    new: { id: null, name, expiresOn, generation: null },
  };
  data = putRotation(withoutFinished(data, key.id, environment), rotation);
  await saveRotations(deps.files, run.rotationsPath, data);

  const made = await provider.issue({ name, like: old, expiresOn });
  if ("refused" in made) {
    await saveRotations(deps.files, run.rotationsPath, dropRotation(data, rotation.id));
    say(`Stopped: ${made.refused}. No token was made, and nothing was changed.`);
    return 1;
  }
  const generation = await generationOf(made.value);
  rotation = {
    ...rotation,
    stage: "issued",
    updatedAt: deps.now().toISOString(),
    new: { id: made.token.id, name: made.token.name, expiresOn: made.token.expiresOn, generation },
  };
  data = putRotation(data, rotation);
  await saveRotations(deps.files, run.rotationsPath, data);
  say(
    `\n  issued ${made.token.id} "${made.token.name}", expires ${made.token.expiresOn ?? "never"}`,
  );

  const problem = await checkNew(provider, made.token.id, made.value, old);
  if (problem) {
    say(`  FAILED the new token's check: ${problem}`);
    return deleteUnchecked(run, data, rotation, provider);
  }
  say(`  checked: ${made.token.id} is active and has the same policies as ${old.id}`);

  say(`keypin: writing the new value to item "${entry.ref.item}", with rotated ${today}`);
  try {
    await vault.write(entry.ref, made.value, { rotated: today });
    const stored = await generationOf(await vault.read(entry.ref));
    if (stored !== generation)
      throw new Error(`the item reads back generation ${stored}, not ${generation}`);
  } catch (error) {
    say(`Stopped: couldn't store the new value: ${messageOf(error)}.`);
    say(
      `The new token ${made.token.id} exists, and the old token still works everywhere. Run keypin rotate ${key.id} again to delete the new token and start over.`,
    );
    return 1;
  }
  rotation = { ...rotation, stage: "stored", updatedAt: deps.now().toISOString() };
  data = putRotation(data, rotation);
  await saveRotations(deps.files, run.rotationsPath, data);
  say(`  stored generation ${generation}`);

  return publishNew(run, data, rotation, { value: made.value, checked });
}

async function publishNew(
  run: Run,
  data: Rotations,
  rotation: Rotation,
  fresh: { value: Secret; checked: Map<string, Checked> } | null,
): Promise<number> {
  const { key, entry, environment, deps, say } = run;
  const state = await loadState(deps.files, run.statePath);
  let value: Secret;
  let checked: Map<string, Checked>;
  const resuming = fresh === null;
  if (fresh) {
    ({ value, checked } = fresh);
  } else {
    say(`It stored the new value (generation ${rotation.new.generation}); this run publishes it.`);
    const found = await checkAccounts(key, entry, deps, say);
    if (!found) {
      say("Stopped: an account check failed. Nothing was read and nothing was written.");
      return 1;
    }
    checked = found;
    if (!deps.isTerminal && approvalsFor({ key, environment, receipts: state.receipts }).length) {
      say("Stopped before reading the value: publishing needs approval, and --yes can't give it.");
      say(rerun(deps, "rotate", run.args));
      return NEEDS_APPROVAL;
    }
    announce(deps.stderr, "the value to publish", [entry.ref]);
    value = await deps.vault().read(entry.ref);
    const generation = await generationOf(value);
    if (generation !== rotation.new.generation) {
      say(
        `Stopped: item "${entry.ref.item}" holds generation ${generation}, not the rotation's ${rotation.new.generation}. Something else changed it. Nothing was written.`,
      );
      return 1;
    }
  }

  const generation = rotation.new.generation ?? (await generationOf(value));
  const plan = planPublish({ key, environment, receipts: state.receipts, generation });
  say(`\nPublishing generation ${generation}:`);
  for (const step of plan.steps) {
    say(`  ${step.action} ${describeTarget(step.target, key.env)}: ${step.reason}`);
    if (step.approval) say(`    needs approval: ${step.approval}`);
  }
  const writes = writesFor(plan.steps, checked);
  if (resuming && writes.length && !(await confirmed(run, plan.needsApproval, "publish"))) {
    return NEEDS_APPROVAL;
  }
  const written = await writeAll({
    key,
    environment,
    entry,
    secret: value,
    generation,
    writes,
    state,
    path: run.statePath,
    deps,
    say,
  });
  if (!written.ok) {
    say(
      `Stopped. The old token still works where the write failed. Run keypin rotate ${key.id} again to finish publishing.`,
    );
    return 1;
  }
  const published: Rotation = {
    ...rotation,
    stage: "published",
    updatedAt: deps.now().toISOString(),
  };
  await saveRotations(deps.files, run.rotationsPath, putRotation(data, published));

  say(`\nPublished. The old token ${rotation.old.id} "${rotation.old.name}" is still active.`);
  say("Next, check that every consumer works with the new value:");
  for (const target of entry.publish) say(`  ${describeTarget(target, key.env)}`);
  for (const consumer of key.consumers) say(`  ${consumer.name} (${consumer.kind})`);
  say(`Then run keypin rotate ${key.id} again to revoke the old token.`);
  return 0;
}

async function revokeOld(run: Run, data: Rotations, rotation: Rotation): Promise<number> {
  const { key, issue, environment, deps, say } = run;
  const generation = rotation.new.generation;
  if (!generation || !rotation.new.id || !rotation.old.id) {
    throw new Error(`rotation ${rotation.id} has no new generation or token IDs`);
  }
  const state = await loadState(deps.files, run.statePath);
  const plan = planPublish({ key, environment, receipts: state.receipts, generation });
  const behind = plan.steps.filter((step) => step.action === "write");
  for (const step of behind) {
    say(`  ${step.destinationId} doesn't have generation ${generation}: ${step.reason}`);
  }
  if (behind.length) {
    say(`Stopped: run keypin publish ${key.id} first. Nothing was revoked.`);
    return 1;
  }
  say(`Every destination's receipt has generation ${generation}.`);
  if (!deps.isTerminal) {
    say(
      "Stopped: revoking needs yes typed in a terminal, and --yes can't give it. Nothing was revoked.",
    );
    say(rerun(deps, "rotate", run.args));
    return NEEDS_APPROVAL;
  }

  announce(deps.stderr, "the admin token", [issue.admin]);
  const provider = deps.provider(issue, await deps.vault().read(issue.admin));
  const current = await provider.details(rotation.new.id);
  if (current?.status !== "active") {
    say(
      `Stopped: the new token ${rotation.new.id} is ${current ? current.status : "gone"}. Nothing was revoked.`,
    );
    return 1;
  }
  const old = await provider.details(rotation.old.id);
  if (!old) {
    say(`The old token ${rotation.old.id} is already gone.`);
    return finish(run, data, rotation);
  }
  say(`\nOld token: ${old.id} "${old.name}", ${old.status}, expires ${old.expiresOn ?? "never"}`);
  say(`  last used: ${old.lastUsedOn ?? "not reported"}`);
  say(
    `New token: ${current.id} "${current.name}", ${current.status}, expires ${current.expiresOn ?? "never"}`,
  );
  const answer = await deps.ask(`Type yes to revoke the old token ${old.id}: `);
  if (answer.trim() !== "yes") {
    say("Not confirmed. Nothing was revoked.");
    return NEEDS_APPROVAL;
  }
  say(`  ${await provider.revoke(old.id)} ${old.id}`);
  return finish(run, data, rotation);
}

async function finish(run: Run, data: Rotations, rotation: Rotation): Promise<number> {
  const done: Rotation = { ...rotation, stage: "revoked", updatedAt: run.deps.now().toISOString() };
  await saveRotations(run.deps.files, run.rotationsPath, putRotation(data, done));
  run.say(
    `Rotated ${run.key.id} (${run.environment}): ${rotation.new.id} replaced ${rotation.old.id}.`,
  );
  return 0;
}

async function abandon(run: Run, data: Rotations, rotation: Rotation): Promise<number> {
  const { entry, issue, deps, say } = run;
  if (rotation.new.generation) {
    announce(deps.stderr, "the current value, to see which token it holds", [entry.ref]);
    const holds = await generationOf(await deps.vault().read(entry.ref));
    if (holds === rotation.new.generation) {
      const problem = await recheck(run, rotation);
      if (problem) {
        say(
          `Stopped: item "${entry.ref.item}" holds the new value, but ${problem}. Nothing was published; fix it by hand, the old token still works everywhere else.`,
        );
        return 1;
      }
      const stored: Rotation = {
        ...rotation,
        stage: "stored",
        updatedAt: deps.now().toISOString(),
      };
      const next = putRotation(data, stored);
      await saveRotations(deps.files, run.rotationsPath, next);
      say(`Item "${entry.ref.item}" already holds the new value (generation ${holds}).`);
      return publishNew(run, next, stored, null);
    }
    if (holds !== rotation.old.generation) {
      say(
        `Stopped: item "${entry.ref.item}" holds generation ${holds}, neither the old ${rotation.old.generation} nor the new ${rotation.new.generation}. Something else changed it. Nothing was changed.`,
      );
      return 1;
    }
  }
  say(
    `It stopped before the new value was stored, so the old token ${rotation.old.id} still works everywhere.`,
  );
  if (!deps.isTerminal) {
    say("Stopped: cleaning it up needs yes typed in a terminal. Nothing was changed.");
    say(rerun(deps, "rotate", run.args));
    return NEEDS_APPROVAL;
  }
  const id = rotation.new.id;
  if (!id) {
    say(
      `Cloudflare may have made a token named "${rotation.new.name}". Look for it under Account API tokens and delete it if it's there.`,
    );
    if ((await deps.ask("Type yes to forget this rotation: ")).trim() !== "yes") {
      say("Not confirmed. Nothing was changed.");
      return NEEDS_APPROVAL;
    }
  } else {
    announce(deps.stderr, "the admin token", [issue.admin]);
    const provider = deps.provider(issue, await deps.vault().read(issue.admin));
    const made = await provider.details(id);
    if (made) {
      say(`New token: ${made.id} "${made.name}", ${made.status}, its value was never stored`);
      if ((await deps.ask(`Type yes to delete the new token ${made.id}: `)).trim() !== "yes") {
        say("Not confirmed. Nothing was changed.");
        return NEEDS_APPROVAL;
      }
      say(`  ${await provider.revoke(made.id)} ${made.id}`);
    } else {
      say(`The new token ${id} is already gone.`);
    }
  }
  await saveRotations(deps.files, run.rotationsPath, dropRotation(data, rotation.id));
  say(`Cleared. Run keypin rotate ${run.key.id} again to start over.`);
  return 1;
}

async function deleteUnchecked(
  run: Run,
  data: Rotations,
  rotation: Rotation,
  provider: TokenProvider,
): Promise<number> {
  const id = rotation.new.id;
  if (!id) throw new Error(`rotation ${rotation.id} has no new token ID`);
  try {
    run.say(`  ${await provider.revoke(id)} ${id}, the token this run made`);
  } catch (error) {
    run.say(`Couldn't delete the new token ${id}: ${messageOf(error)}.`);
    run.say(
      `Nothing else was changed, and the old token still works everywhere. Run keypin rotate ${run.key.id} again to delete it.`,
    );
    return 1;
  }
  await saveRotations(run.deps.files, run.rotationsPath, dropRotation(data, rotation.id));
  run.say("Stopped. Nothing else was changed, and the old token still works everywhere.");
  return 1;
}

async function recheck(run: Run, rotation: Rotation): Promise<string | null> {
  const { entry, issue, deps } = run;
  if (!rotation.new.id || !rotation.old.id) return "the rotation has no token IDs";
  announce(deps.stderr, "the new value and the admin token, to check the new token", [
    entry.ref,
    issue.admin,
  ]);
  const vault = deps.vault();
  const provider = deps.provider(issue, await vault.read(issue.admin));
  const old = await provider.details(rotation.old.id);
  if (!old) return `the old token ${rotation.old.id} is gone, so its policies can't be compared`;
  return checkNew(provider, rotation.new.id, await vault.read(entry.ref), old);
}

async function checkNew(
  provider: TokenProvider,
  id: string,
  value: Secret,
  old: ProviderToken,
): Promise<string | null> {
  try {
    const seen = await provider.verify(value);
    if (seen.id !== id) return `the new value verifies as token ${seen.id}, not ${id}`;
    if (seen.status !== "active") return `the new token is ${seen.status}`;
    const made = await provider.details(id);
    if (!made) return "the admin token can't read the new token";
    if (!sameAccess(made, old)) return `its policies differ from ${old.id}'s`;
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

async function confirmed(run: Run, needsApproval: boolean, what: string): Promise<boolean> {
  const { deps, say } = run;
  if (run.yes && !needsApproval) return true;
  if (deps.isTerminal) {
    const answer = await deps.ask(
      `Type yes to ${what}${needsApproval ? " (this plan needs approval)" : ""}: `,
    );
    if (answer.trim() === "yes") return true;
    say("Not confirmed. Nothing was changed.");
    return false;
  }
  say("Stopped: this plan needs approval, and --yes can't give it. Nothing was changed.");
  say(rerun(deps, "rotate", run.args));
  return false;
}

function withoutFinished(data: Rotations, keyId: string, environment: Environment): Rotations {
  return {
    ...data,
    rotations: data.rotations.filter(
      (r) => !(r.keyId === keyId && r.environment === environment && r.stage === "revoked"),
    ),
  };
}

const DATED = /^(.*) (\d{4}-\d{2}-\d{2})(?: #(\d+))?$/;

export function nextName(old: string, today: string): string {
  const match = DATED.exec(old);
  const base = match?.[1] ?? old;
  if (match?.[2] !== today) return `${base} ${today}`;
  return `${base} ${today} #${Number(match[3] ?? 1) + 1}`;
}

function describeAccess(token: ProviderToken): string[] {
  const lines = ["policies it copies:"];
  for (const policy of token.policies) {
    const groups = policy.permissionGroups.map((g) => g.name).join(", ");
    lines.push(`  ${policy.effect} ${groups}`);
    for (const [resource, scope] of Object.entries(policy.resources)) {
      lines.push(`    on ${resource}: ${JSON.stringify(scope)}`);
    }
  }
  lines.push(`condition: ${token.condition ? JSON.stringify(token.condition) : "none"}`);
  return lines;
}
