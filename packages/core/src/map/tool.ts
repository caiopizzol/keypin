import type { Environment } from "../contracts";
import { isRecord } from "../record";
import { type EnvEntry, type KeyEntry, VARIABLE_NAME } from "./keys-map";
import { type MapContext, rotation, validateTool } from "./key";
import type { Profiles } from "./secretspec";
import type { Table } from "./table";

type Fail = (where: string, message: string) => void;

export interface Tool {
  readonly keys: KeyEntry[];
  readonly ignore: readonly string[];
}

export function readTool(raw: unknown, profiles: Profiles, context: MapContext, fail: Fail): Tool {
  const tool = raw === undefined ? {} : raw;
  if (!isRecord(tool)) {
    fail("", "[tool.keypin] must be a table");
    return { keys: [], ignore: [] };
  }
  const keys: KeyEntry[] = [];
  const keyOf = (name: string): KeyEntry => {
    const found = keys.find((key) => key.name === name);
    if (found) return found;
    const environments: Record<Environment, EnvEntry> = {};
    Reflect.setPrototypeOf(environments, null);
    const key: KeyEntry = { name, rotateEvery: null, environments };
    keys.push(key);
    return key;
  };
  for (const { profile, name, ref } of profiles.declared)
    keyOf(name).environments[profile] = { ref, publish: [] };

  const schedules = new Map<string, { text: string; at: string }>();
  for (const [profile, entries] of Object.entries(tool)) {
    if (profile === "ignore") continue;
    const at = `[tool.keypin.${profile}]`;
    if (!profiles.environments.includes(profile)) {
      fail(`${at}: `, `secretspec.toml has no [profiles.${profile}]`);
      continue;
    }
    if (!isRecord(entries)) {
      fail(`${at}: `, "must be a table of keys, such as [tool.keypin.production.API_KEY]");
      continue;
    }
    for (const [name, entry] of Object.entries(entries)) {
      const where = `[tool.keypin.${profile}.${name}]`;
      const err = (message: string) => fail(`${where}: `, message);
      const declared = keys.find((key) => key.name === name)?.environments[profile];
      if (!declared && profiles.unplaced.has(`${profile} ${name}`)) continue;
      if (!declared) {
        err(
          profiles.derived.has(`${profile} ${name}`)
            ? `${name} is derived from other secrets, so no vault holds it for keypin to publish or rotate`
            : `${name} isn't a secret of [profiles.${profile}]; declare it there or in [profiles.default]`,
        );
        continue;
      }
      const read = validateTool(name, entry, declared.ref, context, err);
      if (!read) continue;
      keyOf(name).environments[profile] = read.entry;
      if (read.rotateEvery === undefined) continue;
      const before = schedules.get(name);
      if (before === undefined) schedules.set(name, { text: read.rotateEvery, at: where });
      else if (before.text !== read.rotateEvery)
        err(
          `rotate_every "${read.rotateEvery}" differs from ${before.at}'s "${before.text}"; a key rotates on one schedule, so set the same rotate_every, or set it once`,
        );
    }
  }
  for (const [name, { text }] of schedules) keyOf(name).rotateEvery = rotation(text, () => {});
  const ignore = readIgnore(tool, keys, (message) => fail("[tool.keypin] ", message));
  return { keys, ignore };
}

function readIgnore(
  tool: Table,
  keys: readonly KeyEntry[],
  fail: (message: string) => void,
): readonly string[] {
  const raw = tool.ignore;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === "string")) {
    fail(`"ignore" must be a list of variable names, such as ["OPENAI_API_KEY"]`);
    return [];
  }
  const names: string[] = [];
  for (const name of raw) {
    const key = keys.find((each) => each.name.toUpperCase() === name.toUpperCase());
    if (!VARIABLE_NAME.test(name))
      fail(
        `ignore "${name}": a variable name uses letters, digits and _, not starting with a digit`,
      );
    else if (names.some((each) => each.toUpperCase() === name.toUpperCase()))
      fail(`ignore "${name}" is listed twice`);
    else if (key !== undefined)
      fail(`ignore "${name}" is also a secret in secretspec.toml; remove it from one of them`);
    else names.push(name);
  }
  return names;
}
