import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { envFileKind, envNames, formatReference, runEnvironment, type Secret } from "@keypin/core";
import { type Child, type Deps, UsageError } from "../deps";
import { errorCode, messageOf } from "../errors";
import { findMap, pickEnvironment } from "../project";
import { announce } from "../vault";

export async function run(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { env: { type: "string" }, only: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  if (!positionals.length) throw new UsageError("keypin run needs a command after --");

  const map = await findMap(deps.files, deps.cwd);
  const environment = pickEnvironment(map, values.env, runEnvironment(map));
  const available = map.keys.flatMap((key) => {
    const entry = key.environments[environment];
    return entry ? [{ key, ref: entry.ref }] : [];
  });
  const keys = values.only ? pick(available, values.only, environment) : available;

  const found = new Map<string, Secret>();
  if (keys.length) {
    announce(
      deps.stderr,
      `${environment} values`,
      keys.map((k) => k.ref),
    );
    const vault = deps.vault();
    const failures: string[] = [];
    for (const { key, ref } of keys) {
      try {
        found.set(key.name, await vault.read(ref));
      } catch (error) {
        failures.push(`${key.name} (${formatReference(ref)}): ${messageOf(error)}`);
      }
    }
    if (failures.length) {
      deps.stderr.write(
        `keypin: couldn't read, so the command didn't start:\n  ${failures.join("\n  ")}\n`,
      );
      return 1;
    }
  }

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(deps.env)) if (value !== undefined) env[name] = value;
  for (const [name, secret] of found) {
    if (env[name] !== undefined) {
      deps.stderr.write(`keypin: ${name} was already set; using the vault's value\n`);
    }
    env[name] = secret.reveal();
  }

  const unsafe = Object.entries(env)
    .filter(([, value]) => value.includes("\0"))
    .map(([name]) => name);
  if (unsafe.length) {
    deps.stderr.write(
      `keypin: ${unsafe.join(", ")} contains a NUL character, which an environment can't hold; the command didn't start\n`,
    );
    return 1;
  }

  await warnAboutEnvFiles(
    deps,
    [...new Set([dirname(map.file), deps.cwd])],
    keys.map((k) => k.key.name),
  );

  let child: Child;
  try {
    child = deps.launch(positionals, env);
  } catch (error) {
    deps.stderr.write(
      `keypin: couldn't start "${positionals[0]}": ${errorCode(error) ?? "unknown error"}\n`,
    );
    return 1;
  }
  const stop = deps.onSignals((signal) => child.kill(signal));
  try {
    return await child.exited;
  } finally {
    stop();
  }
}

function pick<T extends { key: { name: string } }>(
  available: T[],
  only: string[],
  environment: string,
): T[] {
  const wanted = new Set(only.flatMap((value) => value.split(",")).map((name) => name.trim()));
  const unknown = [...wanted].filter((name) => !available.some((k) => k.key.name === name));
  if (unknown.length) {
    const known = available.map((k) => k.key.name).join(", ") || "none";
    throw new UsageError(
      `--only names keys ${environment} has (${known}), got ${unknown.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  return available.filter((k) => wanted.has(k.key.name));
}

async function warnAboutEnvFiles(deps: Deps, folders: string[], mapped: string[]): Promise<void> {
  if (!mapped.length) return;
  for (const folder of folders) {
    const entries = await deps.listFolder(folder).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.kind !== "file" || envFileKind(entry.name) !== "set") continue;
      const path = join(folder, entry.name);
      const text = await deps.files.read(path).catch(() => null);
      if (text === null) continue;
      const names = new Set(envNames(text));
      const held = mapped.filter((name) => names.has(name));
      const file = relative(deps.cwd, path);
      if (entry.name.startsWith(".dev.vars")) deps.stderr.write(devVarsWarning(file, held));
      else if (held.length) deps.stderr.write(envFileWarning(file, held));
    }
  }
}

function devVarsWarning(file: string, keys: string[]): string {
  const found = keys.length ? `still sets ${keys.join(", ")}, and while it exists` : "exists, so";
  return `keypin: ${file} ${found} wrangler dev ignores the keys keypin provides. Give each setting in it a new home, then delete the file.\n`;
}

function envFileWarning(file: string, keys: string[]): string {
  const it = keys.length === 1 ? "it" : "them";
  return `keypin: ${file} still holds a plaintext copy of ${keys.join(", ")}; tools differ on which value wins. Move ${it} out of the file.\n`;
}
