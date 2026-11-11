import { parseArgs } from "node:util";
import { formatReference, runEnvironment, type Secret } from "@keypin/core";
import { type Child, type Deps, UsageError } from "../deps";
import { errorCode, messageOf } from "../errors";
import { findMap, pickEnvironment } from "../project";
import { announce } from "../vault";

export async function run(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { env: { type: "string" } },
    allowPositionals: true,
  });
  if (!positionals.length) throw new UsageError("keypin run needs a command after --");

  const map = await findMap(deps.files, deps.cwd);
  const environment = pickEnvironment(map, values.env, runEnvironment(map));
  const keys = map.keys.flatMap((key) => {
    const entry = key.environments[environment];
    return entry ? [{ key, ref: entry.ref }] : [];
  });

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
