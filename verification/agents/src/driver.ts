import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Writer } from "../../../apps/cli/src/deps";
import { messageOf } from "../../../apps/cli/src/errors";
import {
  contained,
  createSandbox,
  editWorld,
  inside,
  loadWorld,
  openSandbox,
  runKeypin,
  type Sandbox,
} from "./sandbox";
import { FAKE, fakeId, fakeValue, fingerprint, type World } from "./world";

export interface Io {
  cwd: string;
  script: string;
  stdout: Writer;
  stderr: Writer;
}

export const USAGE = `Usage: bun --no-env-file verification/agents/src/main.ts <command>

  new <folder>                       make a sandbox and print its keypin command
  keypin <sandbox> <keypin args...>  run keypin in the sandbox, with no terminal (what
                                     <sandbox>/bin/keypin does)

Playing the user:
  approve <sandbox> [--answer <text>] -- <approval command, or keypin's whole output>
                                     run the command keypin printed, in a terminal that
                                     types --answer (default yes) at every question
  env-file <sandbox> <path> <NAME...>
                                     write an env file inside the sandbox with a fake value
                                     per name (leaks ignores it: the user wrote it)
  item <sandbox> <op://vault/item/field> [--rotated YYYY-MM-DD]
                                     create a 1Password item holding a fake value
  repo <sandbox> <owner/name>        a GitHub repository the gh login administers
  worker <sandbox> <account> <worker>
                                     a Worker the wrangler login can reach
  token <sandbox> <account> <op://vault/item/field> [--admin] [--name <name>]
                                     a Cloudflare account token, stored in a new item
  show <sandbox>                     what the fake 1Password, GitHub and Cloudflare hold
                                     (values as fingerprints, the same as keypin's generation)
  leaks <sandbox> [file...]          fake values found in the sandbox's files or the given
                                     transcripts; exits 1 when any is found
`;

type Command = (args: string[], io: Io) => Promise<number>;

const COMMANDS = new Map<string, Command>([
  ["new", create],
  ["keypin", keypin],
  ["approve", approve],
  ["env-file", envFile],
  ["item", item],
  ["repo", repo],
  ["worker", worker],
  ["token", token],
  ["show", show],
  ["leaks", leaks],
]);

export async function driver(argv: string[], io: Io): Promise<number> {
  const [name, ...args] = argv;
  const command = name === undefined ? undefined : COMMANDS.get(name);
  if (!command) {
    io.stderr.write(USAGE);
    return name === "--help" || name === "help" ? 0 : 2;
  }
  try {
    return await command(args, io);
  } catch (error) {
    io.stderr.write(`sandbox ${name}: ${messageOf(error)}\n`);
    return 1;
  }
}

async function create(args: string[], io: Io): Promise<number> {
  const [folder, ...extra] = args;
  if (folder === undefined || extra.length) throw new Error("new takes one folder");
  const box = await createSandbox(resolve(io.cwd, folder), resolve(io.script));
  io.stdout.write(`sandbox ${box.root}\nkeypin  ${box.bin}\nHOME    ${box.home}\n`);
  return 0;
}

async function keypin(args: string[], io: Io): Promise<number> {
  const [folder, ...rest] = args;
  if (folder === undefined) throw new Error("keypin needs the sandbox folder");
  const box = await openSandbox(folder);
  return runKeypin(box, rest, { cwd: io.cwd, stdout: io.stdout, stderr: io.stderr });
}

async function approve(args: string[], io: Io): Promise<number> {
  const split = args.indexOf("--");
  if (split === -1) throw new Error("approve needs -- before the approval command");
  const { values, positionals } = parseArgs({
    args: args.slice(0, split),
    options: { answer: { type: "string", default: "yes" } },
    allowPositionals: true,
  });
  const [folder] = positionals;
  if (folder === undefined) throw new Error("approve needs the sandbox folder");
  const box = await openSandbox(folder);
  const command = parseApproval(args.slice(split + 1).join(" "));
  if (!(await contained(box, command.cwd)))
    throw new Error(`the approval command runs in ${command.cwd}, outside ${box.root}`);
  const [program, ...rest] = command.words;
  if (program !== box.bin)
    throw new Error(`the approval command runs ${program ?? "nothing"}, not ${box.bin}`);
  const answer = values.answer;
  return runKeypin(box, rest, {
    cwd: command.cwd,
    stdout: io.stdout,
    stderr: io.stderr,
    terminal: async (question) => {
      io.stderr.write(`${question}${answer}\n`);
      return answer;
    },
  });
}

export function parseApproval(text: string): { cwd: string; words: string[] } {
  const lines = text.split("\n").map((line) => line.trim());
  const line = lines.findLast((candidate) => /^cd \S.* && \S/.test(candidate)) ?? text.trim();
  const words = shellWords(line);
  const and = words.indexOf("&&");
  const cwd = words[1];
  if (words[0] !== "cd" || cwd === undefined || and !== 2)
    throw new Error(`expected "cd <folder> && <command>", the line keypin prints, got "${line}"`);
  return { cwd, words: words.slice(3) };
}

export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (quoted) {
      if (char === "'") quoted = false;
      else word = `${word ?? ""}${char}`;
    } else if (char === "'") {
      quoted = true;
      word ??= "";
    } else if (char === "\\" && i + 1 < line.length) {
      word = `${word ?? ""}${line.charAt(++i)}`;
    } else if (char === " " || char === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = `${word ?? ""}${char}`;
    }
  }
  if (quoted) throw new Error(`unclosed quote in "${line}"`);
  if (word !== null) words.push(word);
  return words;
}

async function envFile(args: string[], io: Io): Promise<number> {
  const [folder, path, ...names] = args;
  if (folder === undefined || path === undefined || !names.length)
    throw new Error("env-file takes a sandbox, a path and at least one variable name");
  const box = await openSandbox(folder);
  const file = resolve(io.cwd, path);
  if (!(await contained(box, file))) throw new Error(`${file} is outside ${box.root}`);
  const bad = names.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (bad !== undefined) throw new Error(`"${bad}" isn't a variable name`);
  const lines = names.map(
    (name) => `${name}=${fakeValue(name.toLowerCase().replaceAll("_", "-"))}`,
  );
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${lines.join("\n")}\n`);
  await editWorld(box, (world) => {
    if (!world.planted.includes(file)) world.planted.push(file);
  });
  io.stdout.write(`wrote ${file} with fake values for ${names.join(", ")}\n`);
  return 0;
}

async function item(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { rotated: { type: "string" } },
    allowPositionals: true,
  });
  const [folder, reference, ...extra] = positionals;
  if (folder === undefined || reference === undefined || extra.length)
    throw new Error("item takes a sandbox and one op:// reference");
  const box = await openSandbox(folder);
  const ref = parseRef(reference);
  const value = fakeValue(ref.label);
  await editWorld(box, (world) => {
    addItem(world, ref, value, values.rotated ?? null);
  });
  io.stdout.write(`created ${reference} (fingerprint ${await fingerprint(value)})\n`);
  return 0;
}

async function repo(args: string[], io: Io): Promise<number> {
  const [folder, name, ...extra] = args;
  if (
    folder === undefined ||
    name === undefined ||
    extra.length ||
    !/^[\w.-]+\/[\w.-]+$/.test(name)
  )
    throw new Error("repo takes a sandbox and one owner/name");
  await editWorld(await openSandbox(folder), (world) => {
    if (!world.github.repos.includes(name)) world.github.repos.push(name);
  });
  io.stdout.write(`GitHub repository ${name}, administered by the sandbox's gh login\n`);
  return 0;
}

async function worker(args: string[], io: Io): Promise<number> {
  const [folder, account, name, ...extra] = args;
  if (folder === undefined || account === undefined || name === undefined || extra.length)
    throw new Error("worker takes a sandbox, a Cloudflare account ID and a Worker name");
  await editWorld(await openSandbox(folder), (world) => {
    if (!world.cloudflare.accounts.includes(account)) world.cloudflare.accounts.push(account);
    const id = `${account}/${name}`;
    if (!world.cloudflare.workers.includes(id)) world.cloudflare.workers.push(id);
  });
  io.stdout.write(`Worker ${name} in Cloudflare account ${account}\n`);
  return 0;
}

async function token(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      admin: { type: "boolean", default: false },
      name: { type: "string" },
      rotated: { type: "string" },
    },
    allowPositionals: true,
  });
  const [folder, account, reference, ...extra] = positionals;
  if (folder === undefined || account === undefined || reference === undefined || extra.length)
    throw new Error("token takes a sandbox, a Cloudflare account ID and an op:// reference");
  const box = await openSandbox(folder);
  const ref = parseRef(reference);
  const value = fakeValue(values.admin ? "cloudflare-admin" : "cloudflare-token");
  const id = fakeId();
  await editWorld(box, (world) => {
    addItem(world, ref, value, values.rotated ?? null);
    world.tokens.push({
      id,
      account,
      name: values.name ?? (values.admin ? "keypin admin" : ref.label),
      status: "active",
      expiresOn: null,
      lastUsedOn: null,
      permissions: values.admin ? ["API Tokens Write"] : ["Workers Scripts Write"],
      admin: values.admin,
      value,
    });
  });
  io.stdout.write(`token ${id} in account ${account}, stored in ${reference}\n`);
  return 0;
}

async function show(args: string[], io: Io): Promise<number> {
  const [folder, ...extra] = args;
  if (folder === undefined || extra.length) throw new Error("show takes a sandbox");
  const world = await loadWorld(await openSandbox(folder));
  io.stdout.write(`${JSON.stringify(await described(world), null, 2)}\n`);
  return 0;
}

export async function described(world: World) {
  const print = async (value: string) => `fingerprint ${await fingerprint(value)}`;
  return {
    onePassword: {
      account: world.onePassword.account,
      items: await Promise.all(
        world.onePassword.items.map(async (entry) => ({
          reference: `op://${entry.vault}/${entry.title}`,
          rotated: entry.rotated,
          fields: Object.fromEntries(
            await Promise.all(
              Object.entries(entry.fields).map(async ([name, v]) => [name, await print(v)]),
            ),
          ),
        })),
      ),
    },
    github: {
      login: world.github.login,
      repos: world.github.repos,
      secrets: await Promise.all(
        world.github.secrets.map(async (s) => ({
          place: s.place,
          name: s.name,
          value: await print(s.value),
          updatedAt: s.updatedAt,
        })),
      ),
    },
    cloudflare: {
      login: world.cloudflare.email,
      workers: world.cloudflare.workers,
      secrets: await Promise.all(
        world.cloudflare.secrets.map(async (s) => ({
          place: s.place,
          name: s.name,
          value: await print(s.value),
          updatedAt: s.updatedAt,
        })),
      ),
    },
    tokens: await Promise.all(
      world.tokens.map(async (t) => ({
        id: t.id,
        account: t.account,
        name: t.name,
        status: t.status,
        admin: t.admin,
        value: await print(t.value),
      })),
    ),
  };
}

async function leaks(args: string[], io: Io): Promise<number> {
  const [folder, ...transcripts] = args;
  if (folder === undefined) throw new Error("leaks takes a sandbox and optional transcripts");
  const box = await openSandbox(folder);
  const found = await findLeaks(
    box,
    transcripts.map((path) => resolve(io.cwd, path)),
  );
  for (const leak of found) io.stdout.write(`${leak}\n`);
  io.stdout.write(found.length ? `${found.length} leaks\n` : "no fake value outside the fakes\n");
  return found.length ? 1 : 0;
}

export async function findLeaks(box: Sandbox, transcripts: string[] = []): Promise<string[]> {
  const { planted } = await loadWorld(box);
  const inBox = (await filesIn(box.root, box)).filter((file) => !planted.includes(file));
  const files = [...inBox, ...transcripts];
  const name = (file: string) => (inside(box, file) ? relative(box.root, file) : file);
  const found: string[] = [];
  const pattern = new RegExp(`${FAKE}[\\w-]+`, "g");
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of new Set(text.match(pattern) ?? [])) found.push(`${name(file)}: ${match}`);
  }
  return found;
}

async function filesIn(folder: string, box: Sandbox): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (path === box.world) continue;
    if (entry.isDirectory()) files.push(...(await filesIn(path, box)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

interface ParsedRef {
  vault: string;
  item: string;
  field: string;
  label: string;
}

function parseRef(reference: string): ParsedRef {
  const match = reference.match(/^op:\/\/([^/]+)\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/);
  const [, vault, title, section, field] = match ?? [];
  if (vault === undefined || title === undefined || field === undefined)
    throw new Error(`"${reference}" isn't op://<vault>/<item>/<field>`);
  return {
    vault,
    item: title,
    field: section === undefined ? field : `${section}.${field}`,
    label: title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  };
}

function addItem(world: World, ref: ParsedRef, value: string, rotated: string | null) {
  const found = world.onePassword.items.find(
    (entry) =>
      entry.vault.toLowerCase() === ref.vault.toLowerCase() &&
      entry.title.toLowerCase() === ref.item.toLowerCase(),
  );
  if (found) {
    found.fields[ref.field] = value;
    if (rotated) found.rotated = rotated;
    return;
  }
  world.onePassword.items.push({
    vault: ref.vault,
    title: ref.item,
    fields: { [ref.field]: value },
    rotated,
  });
}
