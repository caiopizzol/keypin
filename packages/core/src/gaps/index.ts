import { DEFAULT_ENVIRONMENTS } from "../contracts";
import type { Needs, Place } from "../discovery";
import type { VaultKinds } from "../login";
import {
  envFlag,
  isEnvironmentName,
  isVariableName,
  type KeysMap,
  publishEnvironment,
  runEnvironment,
} from "../map";
import { envFileSuffix } from "../dotenv";
import { type Found, mappedIn, proposedIn } from "./places";
import type { Fix, Gaps, LocalFile, ProjectScan } from "./report";
import { creating, hasEnvironments, tomlToAdd } from "./toml-to-add";

export type { Fix, Gaps, LocalFile, Need, ProjectScan } from "./report";

export function findGaps(
  scan: ProjectScan,
  map: { map: KeysMap; text: string } | null,
  vaults: VaultKinds,
): Gaps {
  const keys = map?.map ?? null;
  const creates = vaults.find((vault) => vault.newKeys);
  if (!creates?.newKeys) throw new Error("keypin has no vault kind that creates new keys");
  const newKeys = creating(creates, creates.newKeys);
  const listed = keys?.environments ?? DEFAULT_ENVIRONMENTS;
  const environment = publishEnvironment({ environments: listed });
  const notes: string[] = [];
  const needs: Found[] = [];
  const ignore = keys?.ignore ?? [];
  const ignoring = (name: string) =>
    ignore.find((each) => each.toUpperCase() === name.toUpperCase());
  const need = (name: string, place: Place, usedBy: string) => {
    if (!isVariableName(name)) return;
    if (ignoring(name) !== undefined) return;
    const found = needs.find((n) => n.need.name === name && n.place.id === place.id);
    if (found) {
      if (!found.need.usedBy.includes(usedBy)) found.need.usedBy.push(usedBy);
      return;
    }
    needs.push(resolve(name, place, [usedBy]));
  };
  const resolve = (name: string, place: Place, usedBy: string[]): Found => {
    const candidates = (keys?.keys ?? []).filter((k) => place.matches(k.name, name));
    const key =
      candidates.find((k) => mappedIn(keys, k, place) !== null) ??
      candidates.find((k) => k.name === name) ??
      candidates[0] ??
      null;
    const mapped = mappedIn(keys, key, place);
    const holds = place.holds(name);
    return {
      place,
      key,
      need: {
        name,
        to: place.to,
        place: place.label,
        usedBy,
        mapped,
        holds,
        ok: mapped !== null && holds !== false,
      },
    };
  };

  const view = {
    publishEnvironment: environment,
    runEnvironment: runEnvironment({ environments: listed }),
    publishes: (name: string, place: Place) =>
      (keys?.keys ?? []).some(
        (k) => place.matches(k.name, name) && mappedIn(keys, k, place) !== null,
      ),
    ignores: (name: string) => ignoring(name) !== undefined,
  };
  const after: NonNullable<Needs["notesAfter"]>[] = [];
  const conflicts: string[] = [];
  for (const discovered of scan.discovered) {
    const found = discovered.needs(view);
    for (const { name, place, usedBy } of found.needs) need(name, place, usedBy);
    notes.push(...found.notes);
    conflicts.push(...(found.problems ?? []));
    if (found.notesAfter) after.push(found.notesAfter);
  }

  const elsewhere = (found: Found) =>
    found.place.onlyFrom ? mappedIn(keys, found.key, found.place, []) : null;
  const missing = needs.filter((n) => n.need.mapped === null && elsewhere(n) === null);
  const add = tomlToAdd(missing, keys, environment, map?.text ?? "", newKeys, vaults);

  const problems: string[] = [...conflicts];
  const fixes: Fix[] = [];
  const fix = (found: Fix) => {
    fixes.push(found);
    problems.push(found.text);
  };
  const outside = needs.filter(
    ({ need: n, place }) => n.mapped === null && !listed.includes(proposedIn(place, environment)),
  );
  const unlisted = [...new Set(outside.map(({ place }) => proposedIn(place, environment)))];
  const source = outside[0]?.place.onlyFrom?.source;
  if (unlisted.length && source !== undefined) {
    const order =
      listed.length > 1
        ? [...listed.slice(0, -1), ...unlisted, environment]
        : [...listed, ...unlisted];
    const line = `environments = ${JSON.stringify(order).replaceAll(",", ", ")}`;
    const at = hasEnvironments(map?.text ?? "")
      ? "replace the environments line in keypin.toml with"
      : "add at the top of keypin.toml";
    const why = `keypin.toml has no environment for the ${source}${unlisted.length > 1 ? "s" : ""} ${unlisted.join(" and ")}`;
    fix({
      kind: "environments",
      text: `${why}; ${at}: ${line} (keypin run uses the first, keypin publish the last)`,
      why,
      at,
      line,
    });
  }
  for (const found of needs) {
    const { need: n, place, key } = found;
    if (n.ok) continue;
    const uses = `${n.usedBy.join(", ")} ${place.verb} it`;
    const other = elsewhere(found);
    const only = place.onlyFrom;
    if (other !== null && only && n.mapped === null) {
      const why = `${n.name}: ${uses}`;
      const edit = `keypin.toml publishes it to ${place.label} from ${other}, but that ${only.thing} is the ${only.source} ${only.environments.join(" and ")}, so it would get the ${other} value; move that publish entry to ${only.environments.join(" or ")}`;
      fix({ kind: "edit", text: `${why}; ${edit}` });
      continue;
    }
    if (n.mapped !== null) {
      const why = `${n.name}: keypin.toml publishes it to ${place.label}, which doesn't have it yet`;
      const name = key?.name ?? n.name;
      const command = `keypin publish ${name}${envFlag(n.mapped, environment)}`;
      fix({ kind: "publish", text: `${why}; run ${command}`, key: name, why, command });
      continue;
    }
    const held =
      n.holds === true
        ? `${place.label} has it, but keypin.toml doesn't publish it there`
        : n.holds === false
          ? `${place.label} doesn't have it${place.aside?.(n.name) ?? ""}, and keypin.toml doesn't publish it there`
          : `keypin.toml doesn't publish it to ${place.label}`;
    const why = `${n.name}: ${uses}; ${held}`;
    const edit = add.edits.get(`${n.name} ${place.id}`);
    fix(
      edit === undefined
        ? { kind: "add", text: `${why}. Add the TOML below`, why, key: key?.name ?? n.name }
        : { kind: "edit", text: `${why}. ${edit}` },
    );
  }
  const resolved = needs.map((n) => ({ name: n.need.name, place: n.place.id }));
  for (const notesAfter of after) notes.push(...notesAfter(resolved));

  const environments = keys?.environments ?? DEFAULT_ENVIRONMENTS;
  const run = runEnvironment({ environments });
  const byHand = keys
    ? vaults.map((vault) => vault.addByHand?.(keys)).find((text) => text !== undefined)
    : undefined;
  const local: LocalFile[] = [];
  for (const file of scan.envFiles) {
    if (file.kind !== "set") continue;
    const suffix = envFileSuffix(file.path.split("/").at(-1) ?? "");
    const env = suffix !== undefined && environments.includes(suffix) ? suffix : run;
    const flag = envFlag(env, run);
    const caveat =
      suffix !== undefined &&
      !environments.includes(suffix) &&
      isEnvironmentName(suffix) &&
      !/^(local|dev|development)$/.test(suffix)
        ? `maps them as ${run}; if they're the values of another environment, list it in environments and add --env <name>`
        : null;
    const other = caveat === null ? "" : `, which ${caveat}`;
    const names = file.names.filter(isVariableName);
    const key = (name: string) => keys?.keys.find((k) => k.name === name);
    const unmapped = names.filter((name) => ignoring(name) === undefined && !key(name));
    const elsewhere = names.filter((name) => {
      const found = key(name);
      return found !== undefined && !found.environments[env];
    });
    local.push({ file: file.path, tracked: file.tracked, unmapped, elsewhere });
    if (file.tracked)
      fix({
        kind: "tracked",
        text: `${file.path} is tracked by git, so its values may be committed`,
        file: file.path,
      });
    const importing = (why: string, names: string[], account: string) => ({
      kind: "import" as const,
      why,
      vault: newKeys.vault,
      file: file.path,
      names,
      options: `${flag} ${newKeys.options}${account}`,
      caveat: caveat && `That command ${caveat}`,
    });
    if (unmapped.length && byHand !== undefined) {
      const sets = `${file.path} sets ${unmapped.join(", ")}, which keypin.toml doesn't map`;
      notes.push(`${sets}; a plain setting can stay, and for a key ${byHand}`);
    } else if (unmapped.length) {
      const account = newKeys.pinned(keys) ? "" : newKeys.pinOptions;
      const sets = `${file.path} sets ${unmapped.join(", ")}, which keypin.toml doesn't map`;
      const found = importing(sets, unmapped, account);
      const text = `${sets}; a plain setting can stay, and for a key run keypin import ${file.path} NAME...${found.options}${other}`;
      notes.push(text);
      fixes.push({ ...found, text });
    }
    if (elsewhere.length && byHand !== undefined) {
      const why = `${file.path} sets ${elsewhere.join(", ")}, which keypin.toml maps with no ${env} entry`;
      fix({ kind: "edit", text: `${why}; for a key ${byHand}` });
    } else if (elsewhere.length) {
      const why = `${file.path} sets ${elsewhere.join(", ")}, which keypin.toml maps with no ${env} entry`;
      const found = importing(why, elsewhere, "");
      fix({
        ...found,
        text: `${why}; for a key run keypin import ${file.path} ${elsewhere.join(" ")}${found.options}${other}`,
      });
    }
  }

  if (ignore.length)
    notes.push(`keypin.toml ignores ${ignore.length} ${ignore.length === 1 ? "key" : "keys"}`);

  return {
    production: needs.map((n) => n.need),
    local,
    add: add.text,
    addsPin: add.pinned,
    problems,
    notes,
    fixes,
  };
}
