import { parseArgs } from "node:util";
import type { Secret } from "@keypin/core";
import { type Child, type Deps, UsageError } from "../deps";
import { errorCode, messageOf } from "../errors";
import { findMap } from "../project";
import { announce } from "../vault";

export async function run(args: string[], deps: Deps): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (!positionals.length) throw new UsageError("keypin run needs a command after --");

  const map = await findMap(deps.files, deps.cwd);
  const keys = map.keys.flatMap((key) => {
    const dev = key.environments.dev;
    return dev ? [{ key, ref: dev.ref }] : [];
  });
  const skipped = map.keys.filter((key) => !key.environments.dev).map((key) => key.id);
  if (skipped.length) deps.stderr.write(`keypin: no dev entry, not added: ${skipped.join(", ")}\n`);

  const values = new Map<string, Secret>();
  if (keys.length) {
    announce(
      deps.stderr,
      "dev values",
      keys.map((k) => k.ref),
    );
    const vault = deps.vault();
    const failures: string[] = [];
    for (const { key, ref } of keys) {
      try {
        values.set(key.env, await vault.read(ref));
      } catch (error) {
        failures.push(`${key.id} (item "${ref.item}"): ${messageOf(error)}`);
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
  for (const [name, secret] of values) {
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
