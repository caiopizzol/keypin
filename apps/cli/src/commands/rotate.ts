import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  addDays,
  approvalsFor,
  destinationId,
  DUE_SOON_DAYS,
  dropRotation,
  type EnvEntry,
  type Environment,
  envFlag,
  formatReference,
  generationOf,
  type ItemIds,
  type RotateSpec,
  type KeyEntry,
  type KeyOwner,
  type KeysMap,
  latestPerSecret,
  loadRegistry,
  loadRotations,
  loadState,
  ownedBy,
  parseMap,
  periodDays,
  planPublish,
  publishEnvironment,
  type ProviderToken,
  putRotation,
  type Receipt,
  receiptSecretKey,
  rotateCommand,
  type Rotation,
  type Rotations,
  sameAccess,
  saveRotations,
  secretKey,
  type Secret,
  type TokenProvider,
  unfinishedRotation,
} from "@keypin/core";
import { type Deps, localDay, UsageError } from "../deps";
import { messageOf } from "../errors";
import { registryPath, rotationsPath } from "../paths";
import { findMap, MAP_FILE, pickEnvironment } from "../project";
import {
  accountFacts,
  type Checked,
  checkAccounts,
  describeTarget,
  locked,
  NEEDS_APPROVAL,
  planOnly,
  rerun,
  type Say,
  shellWord,
  writeAll,
  writesFor,
} from "../publishing";
import { announce } from "../vault";

const GRACE_DAYS = DUE_SOON_DAYS;

interface Run {
  map: KeysMap;
  key: KeyEntry;
  entry: EnvEntry;
  spec: RotateSpec;
  environment: Environment;
  yes: boolean;
  plan: boolean;
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
      env: { type: "string" },
      yes: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
    },
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
  const spec = entry.rotate;
  if (!spec) {
    throw new Error(
      `key "${keyId}" has no [keys.${keyId}.${environment}.rotate] section in ${map.file}, so keypin can't make a new value`,
    );
  }

  const say: Say = (text) => deps.stderr.write(`${text}\n`);
  return locked(deps, async (statePath) => {
    const run: Run = {
      map,
      key,
      entry,
      spec,
      environment,
      yes: values.yes,
      plan: values.plan,
      args,
      statePath,
      rotationsPath: rotationsPath(deps),
      deps,
      say,
    };
    const data = await loadRotations(deps.files, run.rotationsPath);
    const open = unfinishedRotation(data, keyOwner(run), entry.ref);
    if (!open) return start(run, data);
    say(
      `An unfinished rotation of ${key.name} (${environment}), started ${open.startedAt}, is at stage "${open.stage}".`,
    );
    if (open.provider !== spec.provider || open.account !== spec.account) {
      say(
        `Stopped: that rotation made its token as ${open.provider} in account ${open.account}, and the map now says ${spec.provider} in account ${spec.account}. Put the map back to finish it. Nothing was changed.`,
      );
      return 1;
    }
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
  const { key, entry, spec, environment, deps, say } = run;
  say(`Rotating ${key.name} (${environment}) from ${formatReference(entry.ref)}`);
  say(`  1Password account: ${entry.ref.account}`);
  say(
    `  new token: ${spec.provider} in account ${spec.account}, made with the admin token in ${formatReference(spec.admin)}`,
  );
  for (const target of entry.publish) say(`  to: ${describeTarget(target, key.name)}`);
  if (!entry.publish.length) {
    say(
      `Stopped: the map lists no destinations for ${key.name} (${environment}), so nothing would get the new token. Nothing was changed.`,
    );
    return 1;
  }
  const every = key.rotateEvery;
  const days = periodDays(every);
  if (!days) {
    say(
      `Stopped: rotate needs a rotation period to set the new token's expiry, and ${every ? `rotate_every is "${every}"` : "keypin.toml has no rotate_every for this key"}. Nothing was changed.`,
    );
    return 1;
  }

  const state = await loadState(deps.files, run.statePath);
  const checked = await checkAccounts(key, entry, deps, say);
  if (!checked) {
    say("Stopped: an account check failed. Nothing was read and nothing was changed.");
    return 1;
  }
  const unread = approvalsFor({ ...planFor(run), receipts: state.receipts });
  if (!deps.isTerminal && !run.plan && (unread.length || !run.yes)) {
    for (const approval of unread) say(`  needs approval: ${approval.approval}`);
    say(
      unread.length
        ? "Stopped before reading anything: this rotation needs approval, and --yes can't give it. Nothing was changed."
        : "Stopped before reading anything: no terminal to confirm on. Nothing was changed. Add --yes, or confirm in a terminal.",
    );
    say(rerun(deps, "rotate", run.args));
    return NEEDS_APPROVAL;
  }

  announce(deps.stderr, "the current value and the admin token", [entry.ref, spec.admin]);
  const vault = deps.vault();
  let current: Secret;
  let ids: ItemIds;
  let admin: Secret;
  try {
    ({ secret: current, ids } = await vault.readItem(entry.ref));
    admin = await vault.read(spec.admin);
  } catch (error) {
    say(`Stopped: ${messageOf(error)}. Nothing was changed.`);
    return 1;
  }
  if (current.equals(admin)) {
    say(
      `Stopped: ${formatReference(spec.admin)} holds the same value as ${formatReference(entry.ref)}. The admin token needs its own field, or rotating would overwrite it. Nothing was changed.`,
    );
    return 1;
  }

  const provider = deps.provider(spec, admin);
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

  const approvals = approvalsFor({ ...planFor(run), receipts: state.receipts }, ids);
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
  say(`  store in: ${formatReference(entry.ref)}, with rotated ${today}`);
  for (const target of entry.publish) {
    const found = checked.get(destinationId(target, key.name));
    say(`  publish to: ${describeTarget(target, key.name)}`);
    if (found) say(`    ${accountFacts(found.check)}`);
  }
  for (const approval of approvals) say(`    needs approval: ${approval.approval}`);
  say(`  then stop: the old token stays active until you run ${again(run)} again.`);
  if (run.plan) return planOnly(deps, "rotate", run.args, approvals.length > 0);

  if (!(await confirmed(run, approvals.length > 0, "make the new token"))) return NEEDS_APPROVAL;

  const now = deps.now().toISOString();
  let rotation: Rotation = {
    id: crypto.randomUUID(),
    keyId: key.name,
    environment,
    mapFile: run.map.file,
    item: entry.ref,
    provider: spec.provider,
    account: spec.account,
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
  data = putRotation(withoutFinished(data, keyOwner(run)), rotation);
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

  say(`keypin: writing the new value to ${formatReference(entry.ref)}, with rotated ${today}`);
  try {
    await vault.write(entry.ref, made.value, { rotated: today });
    const readBack = await vault.readItem(entry.ref);
    const stored = await generationOf(readBack.secret);
    if (stored !== generation)
      throw new Error(`the item reads back generation ${stored}, not ${generation}`);
    if (readBack.ids.vault !== ids.vault || readBack.ids.item !== ids.item)
      throw new Error(`it reads back as item ${readBack.ids.item}, not ${ids.item}`);
  } catch (error) {
    say(`Stopped: couldn't store the new value: ${messageOf(error)}.`);
    say(
      `The new token ${made.token.id} exists, and the old token still works everywhere. Run ${again(run)} again to delete the new token and start over.`,
    );
    return 1;
  }
  rotation = { ...rotation, stage: "stored", updatedAt: deps.now().toISOString() };
  data = putRotation(data, rotation);
  await saveRotations(deps.files, run.rotationsPath, data);
  say(`  stored generation ${generation}`);

  return publishNew(run, data, rotation, { value: made.value, ids, checked });
}

async function publishNew(
  run: Run,
  data: Rotations,
  rotation: Rotation,
  fresh: { value: Secret; ids: ItemIds; checked: Map<string, Checked> } | null,
): Promise<number> {
  const { key, entry, environment, deps, say } = run;
  const state = await loadState(deps.files, run.statePath);
  let value: Secret;
  let ids: ItemIds;
  let checked: Map<string, Checked>;
  const resuming = fresh === null;
  if (fresh) {
    ({ value, ids, checked } = fresh);
  } else {
    say(`It stored the new value (generation ${rotation.new.generation}); this run publishes it.`);
    const found = await checkAccounts(key, entry, deps, say);
    if (!found) {
      say("Stopped: an account check failed. Nothing was read and nothing was written.");
      return 1;
    }
    checked = found;
    const approvals = approvalsFor({ ...planFor(run), receipts: state.receipts });
    if (!deps.isTerminal && !run.plan && approvals.length) {
      say("Stopped before reading the value: publishing needs approval, and --yes can't give it.");
      say(rerun(deps, "rotate", run.args));
      return NEEDS_APPROVAL;
    }
    announce(deps.stderr, "the value to publish and the admin token, to check the new token", [
      entry.ref,
      run.spec.admin,
    ]);
    ({ secret: value, ids } = await deps.vault().readItem(entry.ref));
    const generation = await generationOf(value);
    if (generation !== rotation.new.generation) {
      say(
        `Stopped: ${formatReference(entry.ref)} holds generation ${generation}, not the rotation's ${rotation.new.generation}. Something else changed it. Nothing was written.`,
      );
      return 1;
    }
    const problem = await recheck(run, rotation, value);
    if (problem) {
      say(
        `Stopped: ${problem}. Nothing was written, and the rotation stays at "${rotation.stage}". The old token still works where it was published.`,
      );
      return 1;
    }
    say(`  checked: ${rotation.new.id} is active and has the same policies as ${rotation.old.id}`);
  }

  const generation = rotation.new.generation ?? (await generationOf(value));
  const plan = planPublish({ ...planFor(run), receipts: state.receipts, generation, ids });
  say(`\nPublishing generation ${generation}:`);
  for (const step of plan.steps) {
    say(`  ${step.action} ${describeTarget(step.target, key.name)}: ${step.reason}`);
    if (step.approval) say(`    needs approval: ${step.approval}`);
  }
  const writes = writesFor(plan.steps, checked);
  if (run.plan) return planOnly(deps, "rotate", run.args, plan.needsApproval);
  if (resuming && writes.length && !(await confirmed(run, plan.needsApproval, "publish"))) {
    return NEEDS_APPROVAL;
  }
  const written = await writeAll({
    key,
    environment,
    mapFile: run.map.file,
    entry,
    secret: value,
    ids,
    generation,
    writes,
    state,
    path: run.statePath,
    deps,
    say,
  });
  if (!written.ok) {
    say(
      `Stopped. The old token still works where the write failed. Run ${again(run)} again to finish publishing.`,
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
  for (const target of entry.publish) say(`  ${describeTarget(target, key.name)}`);
  say(`Then run ${again(run)} again to revoke the old token.`);
  return 0;
}

async function revokeOld(run: Run, data: Rotations, rotation: Rotation): Promise<number> {
  const { key, spec, environment, deps, say } = run;
  const generation = rotation.new.generation;
  if (!generation || !rotation.new.id || !rotation.old.id) {
    throw new Error(`rotation ${rotation.id} has no new generation or token IDs`);
  }
  const state = await loadState(deps.files, run.statePath);
  const plan = planPublish({ ...planFor(run), receipts: state.receipts, generation, ids: null });
  const behind = plan.steps.filter((step) => step.action === "write");
  for (const step of behind) {
    say(`  ${step.destinationId} doesn't have generation ${generation}: ${step.reason}`);
  }
  const retired = plan.removed.filter(
    (removed) => removed.lastReceipt.generation === rotation.old.generation,
  );
  if (behind.length) {
    say(
      `Stopped: run keypin publish ${key.name}${envFlag(environment, publishEnvironment(run.map))} first. Nothing was revoked.`,
    );
    return 1;
  }
  say(`Every destination of ${key.name} (${environment}) has generation ${generation}.`);
  for (const removed of retired) {
    say(
      `  ${removed.destinationId} left the map and its receipt has the old token (generation ${removed.lastReceipt.generation}); revoking breaks it unless that secret is gone`,
    );
  }
  const others = await otherHolders(run, state.receipts, rotation.old.generation, retired);
  if (others === null) return 1;
  if (others.length) {
    say(
      `Stopped: these destinations still have the old token. Put the new value in each one's vault item, then run its keypin publish. Nothing was revoked.`,
    );
    for (const { receipt, owner } of others) {
      say(`  ${describeHolder(receipt)}: ${publishCommand(owner)}`);
    }
    return 1;
  }
  if (!deps.isTerminal && !run.plan) {
    say(
      "Stopped: revoking needs yes typed in a terminal, and --yes can't give it. Nothing was revoked.",
    );
    say(rerun(deps, "rotate", run.args));
    return NEEDS_APPROVAL;
  }

  announce(deps.stderr, "the current value, to check it's the new token, and the admin token", [
    run.entry.ref,
    spec.admin,
  ]);
  const holds = await generationOf(await deps.vault().read(run.entry.ref));
  if (holds !== generation) {
    say(
      `Stopped: ${formatReference(run.entry.ref)} holds generation ${holds}, not the new ${generation}. Something else changed it, and revoking would leave it with a dead token. Nothing was revoked.`,
    );
    return 1;
  }
  const provider = deps.provider(spec, await deps.vault().read(spec.admin));
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
    if (!run.plan) return finish(run, data, rotation);
    say("The next run records this rotation as finished, and asks nothing.");
    return planOnly(deps, "rotate", run.args, true);
  }
  say(`\nOld token: ${old.id} "${old.name}", ${old.status}, expires ${old.expiresOn ?? "never"}`);
  say(`  last used: ${old.lastUsedOn ?? "not reported"}`);
  say(
    `New token: ${current.id} "${current.name}", ${current.status}, expires ${current.expiresOn ?? "never"}`,
  );
  if (run.plan) return planOnly(deps, "rotate", run.args, true);
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
    `Rotated ${run.key.name} (${run.environment}): ${rotation.new.id} replaced ${rotation.old.id}.`,
  );
  return 0;
}

async function abandon(run: Run, data: Rotations, rotation: Rotation): Promise<number> {
  const { entry, spec, deps, say } = run;
  if (rotation.new.generation) {
    announce(deps.stderr, "the current value, to see which token it holds", [entry.ref]);
    const holds = await generationOf(await deps.vault().read(entry.ref));
    if (holds === rotation.new.generation) {
      const stored: Rotation = {
        ...rotation,
        stage: "stored",
        updatedAt: deps.now().toISOString(),
      };
      const next = putRotation(data, stored);
      if (!run.plan) await saveRotations(deps.files, run.rotationsPath, next);
      say(`${formatReference(entry.ref)} already holds the new value (generation ${holds}).`);
      return publishNew(run, next, stored, null);
    }
    if (holds !== rotation.old.generation) {
      say(
        `Stopped: ${formatReference(entry.ref)} holds generation ${holds}, neither the old ${rotation.old.generation} nor the new ${rotation.new.generation}. Something else changed it. Nothing was changed.`,
      );
      return 1;
    }
  }
  if (rotation.new.generation) {
    const state = await loadState(deps.files, run.statePath);
    const holders = holdersOf(state.receipts, rotation.new.generation);
    if (holders.length) {
      say(
        `Stopped: the new token ${rotation.new.id} was published, so keypin won't delete it. Nothing was changed. Either put the new value back in ${formatReference(entry.ref)} and run ${again(run)} again to finish, or publish the old value to each destination that has the new one:`,
      );
      const owners = await listedOwners(run);
      if (owners === null) return 1;
      for (const r of holders) {
        const owner = ownerOf(r, owners);
        say(
          `  ${describeHolder(r)}: ${owner ? publishCommand(owner) : "no registered map lists it; set that secret to the old value by hand"}`,
        );
      }
      return 1;
    }
  }
  say(
    `It stopped before the new value was stored, so the old token ${rotation.old.id} still works everywhere.`,
  );
  if (run.plan) {
    say(
      rotation.new.id
        ? `The next run deletes the new token ${rotation.new.id} and forgets this rotation.`
        : `Cloudflare may have made a token named "${rotation.new.name}". The next run can't delete it: find it under Account API tokens and delete it, then the next run forgets this rotation.`,
    );
    return planOnly(deps, "rotate", run.args, true);
  }
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
    announce(deps.stderr, "the admin token", [spec.admin]);
    const provider = deps.provider(spec, await deps.vault().read(spec.admin));
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
  say(`Cleared. Run ${again(run)} again to start over.`);
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
      `Nothing else was changed, and the old token still works everywhere. Run ${again(run)} again to delete it.`,
    );
    return 1;
  }
  await saveRotations(run.deps.files, run.rotationsPath, dropRotation(data, rotation.id));
  run.say("Stopped. Nothing else was changed, and the old token still works everywhere.");
  return 1;
}

async function recheck(run: Run, rotation: Rotation, value: Secret): Promise<string | null> {
  if (!rotation.new.id || !rotation.old.id) return "the rotation has no token IDs";
  const provider = run.deps.provider(run.spec, await run.deps.vault().read(run.spec.admin));
  const old = await provider.details(rotation.old.id);
  if (!old) return `the old token ${rotation.old.id} is gone, so its policies can't be compared`;
  return checkNew(provider, rotation.new.id, value, old);
}

function holdersOf(receipts: readonly Receipt[], generation: string | null): Receipt[] {
  return latestPerSecret(receipts).filter((r) => r.generation === generation);
}

function describeHolder(receipt: Receipt): string {
  return `${receipt.destinationId} (${receipt.keyId}, ${receipt.environment})`;
}

interface Owner extends KeyOwner {
  project: string | null;
  publishDefault: Environment;
}

function publishCommand(owner: Owner): string {
  const env = envFlag(owner.environment, owner.publishDefault);
  const where = owner.project === null ? "" : `cd ${shellWord(owner.project)} && `;
  return `${where}keypin publish ${owner.keyId}${env}`;
}

async function listedOwners(run: Run): Promise<Map<string, Owner[]> | null> {
  const { deps, say } = run;
  const owners = new Map<string, Owner[]>();
  const list = (map: KeysMap, project: string | null) => {
    for (const k of map.keys) {
      for (const [name, entry] of Object.entries(k.environments)) {
        for (const target of entry?.publish ?? []) {
          const secret = secretKey(target, k.name);
          owners.set(secret, [
            ...(owners.get(secret) ?? []),
            {
              project,
              keyId: k.name,
              environment: name,
              mapFile: map.file,
              publishDefault: publishEnvironment(map),
            },
          ]);
        }
      }
    }
  };
  list(run.map, null);
  const registry = await loadRegistry(deps.files, registryPath(deps));
  for (const project of registry.projects) {
    const file = join(project, MAP_FILE);
    if (file === run.map.file) continue;
    const text = await deps.files.read(file);
    const result = text === null ? null : parseMap(text, file);
    if (!result?.ok) {
      say(
        `Stopped: ${file} ${result ? "has errors" : "is missing"}, so keypin can't tell which keys use these destinations. Fix it or run keypin unregister ${shellWord(project)}. Nothing was changed.`,
      );
      return null;
    }
    list(result.map, project);
  }
  return owners;
}

function ownerOf(receipt: Receipt, owners: Map<string, Owner[]>): Owner | undefined {
  const found = owners.get(receiptSecretKey(receipt)) ?? [];
  return (
    found.find((o) => ownedBy(receipt, o)) ??
    found.find((o) => o.keyId === receipt.keyId && o.environment === receipt.environment) ??
    found[0]
  );
}

const UNLISTED =
  "no registered map lists it any more; revoking breaks it unless that secret is gone";

async function otherHolders(
  run: Run,
  receipts: readonly Receipt[],
  generation: string | null,
  retired: readonly { destinationId: string }[],
): Promise<{ receipt: Receipt; owner: Owner }[] | null> {
  const owners = await listedOwners(run);
  if (owners === null) return null;
  const shown = new Set(retired.map((r) => r.destinationId));
  return holdersOf(receipts, generation).flatMap((receipt) => {
    const owner = ownerOf(receipt, owners);
    if (owner) return [{ receipt, owner }];
    if (!shown.has(receipt.destinationId)) {
      run.say(`  ${describeHolder(receipt)} has the old token, and ${UNLISTED}`);
    }
    return [];
  });
}

function again(run: Run): string {
  return rotateCommand(run.key.name, run.environment, publishEnvironment(run.map));
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

function withoutFinished(data: Rotations, owner: KeyOwner): Rotations {
  return {
    ...data,
    rotations: data.rotations.filter((r) => !(ownedBy(r, owner) && r.stage === "revoked")),
  };
}

function keyOwner(run: Run): KeyOwner {
  return { keyId: run.key.name, environment: run.environment, mapFile: run.map.file };
}

function planFor(run: Run) {
  return { key: run.key, environment: run.environment, mapFile: run.map.file };
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
