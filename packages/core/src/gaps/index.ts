import { DEFAULT_ENVIRONMENTS, type Environment } from "../contracts";
import type { Needs, Place } from "../discovery";
import type { VaultKinds } from "../login";
import {
  envFileProfile,
  envFlag,
  ignores,
  isEnvironmentName,
  isVariableName,
  type KeysMap,
  publishEnvironment,
  runEnvironment,
} from "../map";
import { envFileSuffix } from "../dotenv";
import { type Found, mappedIn, proposedIn } from "./places";
import type { Fix, Gaps, LocalFile, ProjectScan } from "./report";
import { providerLines } from "./providers";
import { tomlToAdd } from "./toml-to-add";

const PUBLISH_PROFILE = "production";

export type { Fix, Gaps, LocalFile, Need, ProjectScan } from "./report";
export { providerLines, type ProviderLines } from "./providers";

export function findGaps(
  scan: ProjectScan,
  map: { map: KeysMap; text: string } | null,
  vaults: VaultKinds,
): Gaps {
  const keys = map?.map ?? null;
  const listed = keys?.environments ?? DEFAULT_ENVIRONMENTS;
  const environment = publishEnvironment({ environments: listed });
  const notes: string[] = [];
  const needs: Found[] = [];
  const ignore = keys?.ignore ?? [];
  const ignored = new Set<string>();
  const ignoring = (name: string) => {
    const hit = ignores(ignore, name);
    if (hit) ignored.add(name.toUpperCase());
    return hit;
  };
  const need = (name: string, place: Place, usedBy: string) => {
    if (!isVariableName(name)) return;
    if (ignoring(name)) return;
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
    publishes: (name: string, place: Place) =>
      (keys?.keys ?? []).some(
        (k) => place.matches(k.name, name) && mappedIn(keys, k, place) !== null,
      ),
    ignores: ignoring,
    declares: (name: string, profile: Environment) =>
      (keys?.keys ?? []).some(
        (k) => k.name.toUpperCase() === name.toUpperCase() && k.environments[profile] !== undefined,
      ),
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
  const mapText = map?.text ?? "";
  const add = tomlToAdd(missing, keys, environment, mapText);

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
    const tables = unlisted.map((name) => `[profiles.${name}]`);
    const line = tables.join("\n  ");
    const last = environment === listed.at(-1) && environment !== PUBLISH_PROFILE;
    const at = last
      ? `add to secretspec.toml, above [profiles.${environment}] so keypin publish keeps using it`
      : "add to secretspec.toml";
    const why = `secretspec.toml has no profile for the ${source}${unlisted.length > 1 ? "s" : ""} ${unlisted.join(" and ")}`;
    fix({
      kind: "environments",
      text: `${why}; ${at}: ${tables.join(", ")}`,
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
      const edit = `secretspec.toml publishes it to ${place.label} from ${other}, but that ${only.thing} is the ${only.source} ${only.environments.join(" and ")}, so it would get the ${other} value; move that publish entry to ${only.environments.join(" or ")}`;
      fix({ kind: "edit", text: `${why}; ${edit}` });
      continue;
    }
    if (n.mapped !== null) {
      const why = `${n.name}: secretspec.toml publishes it to ${place.label}, which doesn't have it yet`;
      const name = key?.name ?? n.name;
      const command = `keypin publish ${name}${envFlag(n.mapped, environment)}`;
      fix({ kind: "publish", text: `${why}; run ${command}`, key: name, why, command });
      continue;
    }
    const held =
      n.holds === true
        ? `${place.label} has it, but secretspec.toml doesn't publish it there`
        : n.holds === false
          ? `${place.label} doesn't have it${place.aside?.(n.name) ?? ""}, and secretspec.toml doesn't publish it there`
          : `secretspec.toml doesn't publish it to ${place.label}`;
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
    const env = envFileProfile(file.path, { environments });
    const using = `SECRETSPEC_PROFILE=${env} `;
    const caveat =
      suffix !== undefined &&
      !environments.includes(suffix) &&
      isEnvironmentName(suffix) &&
      !/^(local|dev|development)$/.test(suffix)
        ? `declare them in ${run}; if they're the values of another profile, add it to secretspec.toml and set SECRETSPEC_PROFILE=<name>`
        : null;
    const other = caveat === null ? "" : `; these commands ${caveat}`;
    const names = file.names.filter(isVariableName);
    const key = (name: string) => keys?.keys.find((k) => k.name === name);
    const unmapped = names.filter((name) => !ignoring(name) && !key(name));
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
    const importing = (why: string, names: string[]) => ({
      kind: "import" as const,
      why,
      file: file.path,
      profile: env,
      names,
      commands: [
        ...names.map((name) => `${using}secretspec add ${name}`),
        `${using}secretspec import dotenv:${file.path}`,
      ],
      caveat: caveat && `These commands ${caveat}`,
    });
    if (unmapped.length && byHand !== undefined) {
      const sets = `${file.path} sets ${unmapped.join(", ")}, which secretspec.toml doesn't declare`;
      notes.push(`${sets}; a plain setting can stay, and for a key ${byHand}`);
    } else if (unmapped.length) {
      const sets = `${file.path} sets ${unmapped.join(", ")}, which secretspec.toml doesn't declare`;
      const found = importing(sets, unmapped);
      const text = `${sets}; a plain setting can stay, and for a key run ${using}secretspec add NAME, then ${using}secretspec import dotenv:${file.path}${other}`;
      notes.push(text);
      fixes.push({ ...found, text });
    }
    if (elsewhere.length && byHand !== undefined) {
      const why = `${file.path} sets ${elsewhere.join(", ")}, which secretspec.toml declares, but not in profile ${env}`;
      fix({ kind: "edit", text: `${why}; for a key ${byHand}` });
    } else if (elsewhere.length) {
      const why = `${file.path} sets ${elsewhere.join(", ")}, which secretspec.toml declares, but not in profile ${env}`;
      const found = importing(why, elsewhere);
      fix({ ...found, text: `${why}; for a key run ${found.commands.join(", then ")}${other}` });
    }
  }

  const unused = ignore.filter((name) => !ignored.has(name.toUpperCase()));
  const drop = !unused.length
    ? ""
    : unused.length === 1
      ? `; ${unused[0]} isn't in any file check read, so remove it from ignore`
      : `; ${unused.join(", ")} aren't in any file check read, so remove them from ignore`;
  if (ignore.length)
    notes.push(
      `secretspec.toml ignores ${ignore.length} ${ignore.length === 1 ? "key" : "keys"}${drop}`,
    );

  return {
    production: needs.map((n) => n.need),
    local,
    add: add.text,
    providers: providerLines(
      mapText,
      [
        ...add.declares,
        ...fixes.flatMap((found) => (found.kind === "import" ? [found.profile] : [])),
      ],
      vaults,
    ),
    problems,
    notes,
    fixes,
  };
}
