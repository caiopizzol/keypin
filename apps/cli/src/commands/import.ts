import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_ENVIRONMENTS,
  draftItemName,
  envFileKind,
  envValues,
  formatReference,
  isVariableName,
  type KeyRef,
  type KeysMap,
  parseMap,
  runEnvironment,
  type Secret,
} from "@keypin/core";
import { type Deps, localDay, UsageError } from "../deps";
import { messageOf } from "../errors";
import { MAP_FILE } from "../project";
import { NEEDS_APPROVAL, rerun } from "../publishing";
import { registerProject, TEMPLATE } from "./init";

const ROTATE_EVERY = "90d";

interface Request {
  envFile: string;
  vault: string;
  account: string | undefined;
  yes: boolean;
  args: string[];
}

interface Import {
  name: string;
  ref: KeyRef;
  value: Secret;
}

interface Skip {
  name: string;
  reason: string;
  onlyInFile: boolean;
  exists?: boolean;
}

interface Target {
  file: string;
  found: string | null;
  map: KeysMap | null;
  account: string;
}

export async function importEnv(args: string[], deps: Deps): Promise<number> {
  const request = parseRequest(args);
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  const envPath = resolve(deps.cwd, request.envFile);
  if (envFileKind(basename(envPath)) === "expected")
    throw new UsageError(`${envPath} is an example file; import the file that sets the values`);
  const text = await deps.files.read(envPath);
  if (text === null) throw new Error(`${envPath} doesn't exist`);

  const target = await readTarget(deps, request);
  const environment = runEnvironment(target.map ?? { environments: DEFAULT_ENVIRONMENTS });
  const project = basename(deps.cwd);
  const values = envValues(text);
  if (!values.size) throw new Error(`${envPath} sets no variables; nothing to import`);

  const planned: Import[] = [];
  const skips: Skip[] = [];
  const items = new Map<string, string>();
  for (const [name, value] of values) {
    const item = draftItemName(project, environment, name);
    const sameItem = items.get(item.toLowerCase());
    if (!isVariableName(name))
      skips.push({
        name,
        reason: "not a variable name (letters, digits and _, not a digit first)",
        onlyInFile: true,
      });
    else if (!value.reveal()) skips.push({ name, reason: "the value is empty", onlyInFile: false });
    else if (target.map?.keys.some((key) => key.name === name))
      skips.push({
        name,
        reason: `already mapped in ${target.file}; left as it is`,
        onlyInFile: false,
      });
    else if (sameItem !== undefined)
      skips.push({
        name,
        reason: `its item would be "${item}", the same as ${sameItem}'s`,
        onlyInFile: true,
      });
    else {
      items.set(item.toLowerCase(), name);
      planned.push({ name, value, ref: refFor(target.account, request.vault, item) });
    }
  }

  let imports = planned;
  const stored: Import[] = [];
  if (planned.length) {
    if (await deps.isLink(target.file))
      throw new Error(`${target.file} is a symbolic link; keypin import doesn't follow one`);
    const check = parseMap(mapText(target, planned, environment), target.file);
    if (!check.ok)
      throw new Error(
        `adding the keys to ${target.file} wouldn't parse, so nothing was created: ${check.errors.join("; ")}`,
      );
    const scope = { kind: "1password" as const, account: target.account, vault: request.vault };
    say(
      `keypin: listing the items in vault ${request.vault} of 1Password account ${target.account}`,
    );
    const titles = new Set((await deps.vault().list(scope)).map((i) => i.title.toLowerCase()));
    imports = [];
    for (const entry of planned) {
      if (!titles.has(entry.ref.item.toLowerCase())) {
        imports.push(entry);
        continue;
      }
      const problem = await existingProblem(deps, entry);
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

  const today = localDay(deps.now());
  say(`Import ${envPath} into 1Password account ${target.account}, vault ${request.vault}:`);
  for (const { name, ref } of imports)
    say(
      `  create "${ref.item}" (password, rotated ${today}), and map ${name} to ${formatReference(ref)}`,
    );
  if (!imports.length) say("  nothing to create");
  for (const { name, ref } of stored)
    say(`  map ${name} to ${formatReference(ref)}, an item that exists with the same value`);
  if (skips.length) {
    say("Skipped:");
    for (const skip of skips) say(`  ${skip.name}: ${skip.reason}`);
  }
  const existed = skips.some((skip) => skip.exists);
  if (!imports.length && !stored.length) return existed ? 1 : 0;
  say(
    target.map
      ? `Map: add ${count(imports.length + stored.length, "key")} at the end of ${target.file}`
      : `Map: write ${target.file} and register ${deps.cwd}`,
  );

  if (imports.length && !(await confirmed(deps, request, imports.length))) return NEEDS_APPROVAL;

  const created: Import[] = [];
  for (const entry of imports) {
    try {
      await deps.vault().write(entry.ref, entry.value, { rotated: today, newItem: true });
      created.push(entry);
      say(`  created "${entry.ref.item}"`);
    } catch (error) {
      say(`  FAILED "${entry.ref.item}": ${messageOf(error)}`);
      break;
    }
  }
  const failed = imports.filter((entry) => !created.includes(entry)).map((i) => i.name);
  if (failed.length)
    say(`Stopped. Created ${names(created.map((i) => i.name))}; not created: ${names(failed)}.`);
  const mapped = planned.filter((entry) => stored.includes(entry) || created.includes(entry));
  if (!mapped.length) return 1;

  try {
    await writeMap(deps, target, mapped, environment);
  } catch (error) {
    say(`keypin: ${messageOf(error)}`);
    say(`The items are in 1Password. Add these tables to ${target.file} by hand:`);
    deps.stdout.write(keyTables(mapped, environment));
    return 1;
  }
  say(`keypin: mapped ${names(mapped.map((i) => i.name))} in ${target.file}`);
  if (!target.map) await registerProject(deps, deps.cwd);

  const left = [...skips.filter((skip) => skip.onlyInFile).map((skip) => skip.name), ...failed];
  say(
    `The imported values are now in 1Password, and keypin run -- <command> provides them. keypin left ${envPath} as it is.`,
  );
  say(
    left.length
      ? `${names(left)} ${left.length === 1 ? "is" : "are"} still only in that file. Move ${left.length === 1 ? "it" : "them"}, then delete the file and stop loading it (for example, wrangler dev reads .dev.vars).`
      : "Delete it and stop loading it (for example, wrangler dev reads .dev.vars).",
  );
  if (failed.length)
    say(
      "Run keypin import again to create the rest. It maps an item it already stored, since that item holds the same value.",
    );
  return failed.length || existed ? 1 : 0;
}

async function existingProblem(deps: Deps, entry: Import): Promise<string | null> {
  try {
    const value = await deps.vault().read(entry.ref);
    return value.reveal() === entry.value.reveal() ? null : "with another value";
  } catch (error) {
    return `and couldn't be read (${messageOf(error)})`;
  }
}

function names(list: readonly string[]): string {
  return list.length ? list.join(", ") : "none";
}

function parseRequest(args: string[]): Request {
  const { values, positionals } = parseArgs({
    args,
    options: {
      vault: { type: "string" },
      account: { type: "string" },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [envFile, ...extra] = positionals;
  if (envFile === undefined || extra.length)
    throw new UsageError("keypin import takes one env file, such as .env or .dev.vars");
  const vault = values.vault?.trim();
  if (!vault)
    throw new UsageError("--vault is required: the 1Password vault to create the items in");
  if (vault.includes("/")) throw new UsageError("--vault is a vault name, without /");
  const account = values.account?.trim();
  if (values.account !== undefined && !account)
    throw new UsageError("--account is your 1Password sign-in address, such as my.1password.com");
  return { envFile, vault, account, yes: values.yes, args };
}

async function readTarget(deps: Deps, request: Request): Promise<Target> {
  const file = join(deps.cwd, MAP_FILE);
  const found = await deps.files.read(file);
  if (found === null || found === TEMPLATE) {
    if (!request.account)
      throw new UsageError(
        `--account is required: ${file} doesn't name a 1Password account yet, so give its sign-in address, such as my.1password.com`,
      );
    return { file, found, map: null, account: request.account };
  }
  const parsed = parseMap(found, file);
  if (!parsed.ok) throw new Error(`fix ${file} first: ${parsed.errors.join("; ")}`);
  const account = parsed.map.account ?? request.account;
  if (!account)
    throw new UsageError(
      `--account is required: ${file} has no [1password] account, so give its sign-in address, such as my.1password.com`,
    );
  if (request.account && request.account !== account)
    throw new UsageError(
      `${file} uses 1Password account ${account}, not ${request.account}; drop --account`,
    );
  return { file, found, map: parsed.map, account };
}

function refFor(account: string, vault: string, item: string): KeyRef {
  return { kind: "1password", account, vault, item, section: null, field: "password" };
}

function keyTables(imports: readonly Import[], environment: string): string {
  return imports
    .map(
      ({ name, ref }) =>
        `\n[keys.${name}]\nrotate_every = ${str(ROTATE_EVERY)}\n${environment} = ${str(formatReference(ref))}\n`,
    )
    .join("");
}

function mapText(target: Target, imports: readonly Import[], environment: string): string {
  const account = `[1password]\naccount = ${str(target.account)}\n`;
  if (!target.map || target.found === null)
    return `# Written by keypin import. The values are in 1Password; this file holds only references.\n\n${account}${keyTables(imports, environment)}`;
  const base = target.found.endsWith("\n") || !target.found ? target.found : `${target.found}\n`;
  return `${base}${target.map.account ? "" : `\n${account}`}${keyTables(imports, environment)}`;
}

async function writeMap(
  deps: Deps,
  target: Target,
  imports: readonly Import[],
  environment: string,
): Promise<void> {
  const text = mapText(target, imports, environment);
  const check = parseMap(text, target.file);
  if (!check.ok)
    throw new Error(`the new ${target.file} doesn't parse: ${check.errors.join("; ")}`);
  const result =
    target.found === null
      ? await deps.createFile(target.file, text)
      : await deps.replaceFile(target.file, target.found, text);
  if (result === "link")
    throw new Error(`${target.file} is a symbolic link; keypin import doesn't follow one`);
  if (result === "exists" || result === "changed")
    throw new Error(`${target.file} changed while import ran, so it wasn't written`);
}

async function confirmed(deps: Deps, request: Request, items: number): Promise<boolean> {
  const say = (text: string) => deps.stderr.write(`${text}\n`);
  if (request.yes) return true;
  if (deps.isTerminal) {
    const answer = await deps.ask(`Type yes to create ${count(items, "item")} in 1Password: `);
    if (answer.trim() === "yes") return true;
    say("Not confirmed. Nothing was created.");
    return false;
  }
  say(
    "Stopped: no terminal to confirm on. Nothing was created. Confirm in a terminal, or add --yes.",
  );
  say(rerun(deps, "import", request.args));
  return false;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function str(value: string): string {
  return JSON.stringify(value);
}
