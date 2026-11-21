import { basename, resolve } from "node:path";
import {
  DEFAULT_ENVIRONMENTS,
  envFileKind,
  envFlag,
  envValues,
  isVariableName,
  localDay,
  messageOf,
  parseMap,
  runEnvironment,
  type Secret,
} from "@keypin/core";
import { type Deps, UsageError } from "../../deps";
import { count, output } from "../../output";
import { confirmed, NEEDS_APPROVAL } from "../../approval";
import { approval } from "../../sign-in";
import { registerProject } from "../init";
import { parseRequest } from "./request";
import { draftItemName, type Import, type Skip, refFor, planRows, compareMapped } from "./plan";
import {
  readTarget,
  chosenEnvironment,
  extendsKey,
  mapAddition,
  mapText,
  writeMap,
} from "./target";

const DOLLAR = "the value has a $, which some loaders expand to another variable's value";

export async function importEnv(args: string[], deps: Deps): Promise<number> {
  const request = parseRequest(args);
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const say = (text: string) => out.line(text);
  const envPath = resolve(deps.cwd, request.envFile);
  if (envFileKind(basename(envPath)) === "expected")
    throw new UsageError(`${envPath} is an example file; import the file that sets the values`);
  const text = await deps.files.read(envPath);
  if (text === null) throw new Error(`${envPath} doesn't exist`);

  const target = await readTarget(deps, request);
  const environments = target.map?.environments ?? DEFAULT_ENVIRONMENTS;
  const runs = runEnvironment({ environments });
  const environment = chosenEnvironment(request.env, environments, runs, target);
  const project = basename(deps.cwd);
  const file = envValues(text);
  const values = selected(file, request.names, envPath);
  if (!file.size) throw new Error(`${envPath} sets no variables; nothing to import`);

  const planned: Import[] = [];
  let skips: Skip[] = [];
  const items = new Map<string, string>();
  for (const [name, value] of values) {
    const item = draftItemName(project, environment, name);
    const sameItem = items.get(item.toLowerCase());
    const mapped = target.map?.keys.find((key) => key.name === name);
    if (!isVariableName(name))
      skips.push({
        name,
        reason: "not a variable name (letters, digits and _, not a digit first)",
        onlyInFile: true,
      });
    else if (value.isEmpty())
      skips.push({
        name,
        reason: "the value is empty",
        onlyInFile: false,
        mappedEmpty: Boolean(mapped?.environments[environment]),
      });
    else if (mapped?.environments[environment] && value.includes("$"))
      skips.push({
        name,
        reason: `already mapped in ${target.file}; left as it is, but ${DOLLAR}, so keypin can't compare it with the vault`,
        onlyInFile: true,
      });
    else if (mapped?.environments[environment])
      skips.push({
        name,
        reason: `already mapped in ${target.file}; left as it is`,
        onlyInFile: false,
        mapped: { ref: mapped.environments[environment].ref, value },
      });
    else if (mapped && !extendsKey(deps, target, { name, vault: request.vault, item, environment }))
      skips.push({
        name,
        reason: `mapped in ${target.file} without ${environment}, in a form keypin can't add a table to; add its ${environment} reference by hand`,
        onlyInFile: true,
      });
    else if (value.includes("$"))
      skips.push({
        name,
        reason: DOLLAR,
        onlyInFile: true,
      });
    else if (sameItem !== undefined)
      skips.push({
        name,
        reason: `its item would be "${item}", the same as ${sameItem}'s`,
        onlyInFile: true,
      });
    else {
      items.set(item.toLowerCase(), name);
      planned.push({
        name,
        value,
        ref: refFor(target.account, request.vault, item),
        existing: mapped !== undefined,
      });
    }
  }

  say(
    `\n${out.bold("Import")} ${envPath}  ${out.dim(`into 1Password account ${target.account}, vault ${request.vault}`)}`,
  );
  let imports = planned;
  const stored: Import[] = [];
  if (planned.length) {
    if (await deps.isLink(target.file))
      throw new Error(`${target.file} is a symbolic link; keypin import doesn't follow one`);
    const check = parseMap(
      mapText(target, planned, environment),
      target.file,
      deps.destinations,
      deps.issuers,
      deps.vaults,
      deps.pulls,
    );
    if (!check.ok)
      throw new Error(
        `adding the keys to ${target.file} wouldn't parse, so nothing was created: ${check.errors.join("; ")}`,
      );
    const scope = { kind: "1password" as const, account: target.account, vault: request.vault };
    const where = `vault ${request.vault} of 1Password account ${target.account}`;
    const titles = await out.step(
      `Listing vault ${request.vault}`,
      async () => new Set((await deps.vault().list(scope)).map((i) => i.title.toLowerCase())),
      () => ({ ok: true, text: `Listed the items in ${where}, not the values` }),
      approval(
        deps,
        planned.map((entry) => entry.ref),
      ),
    );
    const found = planned.filter((entry) => titles.has(entry.ref.item.toLowerCase()));
    imports = planned.filter((entry) => !found.includes(entry));
    const problems = new Map<Import, string | null>();
    const existing = `${count(found.length, "item")} that already ${found.length === 1 ? "exists" : "exist"}, to compare with the file`;
    if (found.length)
      await out.step(
        `Reading ${count(found.length, "existing item")}`,
        async () => {
          let unread = 0;
          for (const entry of found) {
            try {
              const value = await deps.vault().read(entry.ref);
              problems.set(entry, value.equals(entry.value) ? null : "with another value");
            } catch (error) {
              unread++;
              problems.set(entry, `and couldn't be read (${messageOf(error)})`);
            }
          }
          return unread;
        },
        (unread) => ({ ok: !unread, text: `Read ${existing}` }),
        approval(
          deps,
          planned.map((entry) => entry.ref),
        ),
      );
    for (const entry of found) {
      const problem = problems.get(entry) ?? null;
      if (problem === null) stored.push(entry);
      else
        skips.push({
          name: entry.name,
          reason: `"${entry.ref.item}" already exists in vault ${request.vault} ${problem}; keypin doesn't overwrite it`,
          onlyInFile: true,
          exists: true,
        });
    }
  }

  skips = await compareMapped(deps, out, skips);

  const today = localDay(deps.now());
  say(`\n${out.bold("Plan")}`);
  for (const row of planRows(imports, stored, skips, today, out, deps.vaults)) say(`  ${row}`);
  const existed = skips.some((skip) => skip.exists);
  if (!imports.length && !stored.length) {
    say(`Nothing was imported, and ${target.file} wasn't changed.`);
    return existed ? 1 : 0;
  }
  const adding = [...imports, ...stored];
  const fresh = adding.filter((entry) => !entry.existing).length;
  const existing = adding.filter((entry) => entry.existing).map((entry) => entry.name);
  const additions = [
    fresh ? count(fresh, "key") : "",
    existing.length ? `${environment} for ${names(existing)}` : "",
  ].filter(Boolean);
  say(
    target.map
      ? `Map: add ${additions.join(", and ")} at the end of ${target.file}`
      : `Map: write ${target.file} and register ${deps.cwd}`,
  );

  const question = `Create ${count(imports.length, "item")} in 1Password?`;
  const confirm = { ...request, command: "import", needsApproval: false, question };
  const hint = "Confirm in a terminal, or add --yes.";
  if (imports.length && !(await confirmed(deps, confirm, "Nothing was created.", hint)))
    return NEEDS_APPROVAL;

  const created: Import[] = [];
  if (imports.length) say("");
  for (const [index, entry] of imports.entries()) {
    const problem = await out.step(
      `Creating item ${index + 1} of ${imports.length}`,
      () =>
        deps
          .vault()
          .write(entry.ref, entry.value, { rotated: today, newItem: true })
          .then(
            () => null,
            (error: unknown) => messageOf(error),
          ),
      (problem) => ({
        ok: problem === null,
        text: `${problem === null ? "Created" : "Couldn't create"} "${entry.ref.item}" in vault ${request.vault}`,
      }),
      approval(deps, [entry.ref]),
    );
    if (problem !== null) {
      say(`    ${problem}`);
      break;
    }
    created.push(entry);
  }
  const failed = imports.filter((entry) => !created.includes(entry)).map((i) => i.name);
  if (failed.length)
    say(`Stopped. Created ${names(created.map((i) => i.name))}; not created: ${names(failed)}.`);
  const mapped = planned.filter((entry) => stored.includes(entry) || created.includes(entry));
  if (!mapped.length) return 1;

  try {
    await writeMap(deps, target, mapped, environment);
  } catch (error) {
    say(`${out.mark(false)} ${messageOf(error)}`);
    say(
      target.map
        ? `The items are in 1Password. Add this at the end of ${target.file} by hand:`
        : `The items are in 1Password. Save this as ${target.file} by hand:`,
    );
    deps.stdout.write(mapAddition(target, mapped, environment));
    return 1;
  }
  say(`${out.mark(true)} Mapped ${names(mapped.map((i) => i.name))} in ${target.file}`);
  if (!target.map) await registerProject(deps, deps.cwd);
  say("");

  const left = [...skips.filter((skip) => skip.onlyInFile).map((skip) => skip.name), ...failed];
  const done = new Set([
    ...mapped.map((entry) => entry.name),
    ...skips.filter((skip) => skip.mapped && !skip.onlyInFile).map((skip) => skip.name),
    ...skips.filter((skip) => skip.mappedEmpty).map((skip) => skip.name),
  ]);
  const remove = [...file.keys()].filter((name) => done.has(name));
  const rest = [...file].filter(
    ([name, value]) => !remove.includes(name) && (left.includes(name) || !value.isEmpty()),
  );
  say(
    `The imported values are now in 1Password, and keypin run${envFlag(environment, runs)} -- <command> provides them. keypin left ${envPath} as it is.`,
  );
  if (left.length)
    say(
      `${names(left)} ${left.length === 1 ? "is" : "are"} still only in that file, for the reason in the plan.`,
    );
  if (basename(envPath).startsWith(".dev.vars"))
    say(
      rest.length
        ? `Delete it once ${names(rest.map(([name]) => name))} ${rest.length === 1 ? "has" : "have"} a new home: while a .dev.vars file exists, wrangler dev reads secrets only from it and ignores the ones keypin run provides. Import a secret among them too. A plain setting that isn't secret can go to wrangler dev --var NAME:value; [vars] in the wrangler config also deploys.`
        : "Nothing else is set in it. Delete it: while a .dev.vars file exists, wrangler dev ignores the secrets keypin run provides.",
    );
  else
    say(
      rest.length
        ? `Remove the ${names(remove)} ${remove.length === 1 ? "line" : "lines"} from it: keypin run warns while an env file holds a key it provides.`
        : "Nothing else is set in it. Delete it and stop loading it.",
    );
  if (failed.length)
    say(
      "Run keypin import again to create the rest. It maps an item it already stored, since that item holds the same value.",
    );
  return failed.length || existed ? 1 : 0;
}

function selected(
  file: Map<string, Secret>,
  wanted: readonly string[],
  envPath: string,
): Map<string, Secret> {
  if (!wanted.length) return file;
  const missing = wanted.filter((name) => !file.has(name));
  if (missing.length)
    throw new UsageError(`${envPath} doesn't set ${names(missing)}; name variables it sets`);
  return new Map([...file].filter(([name]) => wanted.includes(name)));
}

function names(list: readonly string[]): string {
  return list.length ? list.join(", ") : "none";
}
