import { dirname } from "node:path";
import {
  checkId,
  findGaps,
  formatReference,
  type Gaps,
  kindOf,
  type KeyRef,
  type KeysMap,
  loadRegistry,
  parseMap,
  type PublishTarget,
  pullPlace,
  type PullReader,
  secretKey,
  sentence,
  vaultAccounts,
} from "@keypin/core";
import { type Deps } from "../../deps";
import { count, output } from "../../output";
import { registryPath } from "../../paths";
import { locateMap, MAP_FILE } from "../../project";
import { publisherFor } from "../../publisher";
import { scanProject } from "../../scan";
import { approval, mapSignIn } from "../../sign-in";
import { distinctRefs, refKey } from "../../vault";
import { type CheckedItem, type DestinationResult, type Report, ITEM_NOTE } from "./report";
import { prerequisites, loginLine, checkItem, checkDestination } from "./lookups";
import { type Step, ORDER, plan } from "./steps";

function publishedAt(map: KeysMap, name: string, reader: PullReader, deps: Deps): string[] {
  const place = pullPlace(reader, deps.pulls);
  const secret = (target: PublishTarget, key: string) => secretKey(target, key, deps.destinations);
  return map.keys.flatMap((other) =>
    map.environments.flatMap((environment) =>
      other.environments[environment]?.publish.some(
        (target) =>
          checkId(target, deps.destinations) === place &&
          secret(target, other.name) === secret(target, name),
      )
        ? [other.name === name ? environment : `${other.name} (${environment})`]
        : [],
    ),
  );
}

export async function build(
  folder: string,
  deps: Deps,
): Promise<{ report: Report; steps: Step[]; read: string }> {
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const steps: Step[] = [];
  const problem = (
    order: number,
    title: string,
    body: string[],
    text: string,
    signIn?: KeyRef["kind"],
  ) => {
    report.problems.push(text);
    steps.push({ order, title, body, covers: [text], signIn });
  };
  const found = await locateMap(deps.files, folder);
  const parsed = found
    ? parseMap(found.text, found.file, deps.destinations, deps.issuers, deps.vaults, deps.pulls)
    : null;
  const mapped = parsed?.ok
    ? parsed.map.keys.flatMap((key) =>
        Object.values(key.environments).flatMap((e) => (e ? [e.ref] : [])),
      )
    : [];
  const signIn = mapSignIn(deps, parsed?.ok ? parsed.map : null, mapped);
  const root = found ? dirname(found.file) : folder;
  const pulled = parsed?.ok
    ? parsed.map.keys.flatMap((key) =>
        parsed.map.environments.flatMap((environment) =>
          (key.environments[environment]?.pull ?? []).map((reader) => ({
            key: key.name,
            environment,
            reader,
            publishedIn: publishedAt(parsed.map, key.name, reader, deps),
          })),
        ),
      )
    : [];
  const scanned = await scanProject(deps, root, pulled);
  const head = {
    folder: root,
    map: found?.file ?? null,
    registered: false,
    read: { ...scanned.files, notScanned: scanned.nested },
  };
  const tail = {
    onePassword: signIn && {
      signIn: signIn.mode,
      address: signIn.mode === "service-account" ? signIn.address : null,
    },
    keys: [],
    production: [],
    local: [],
    add: null,
    unknown: scanned.unknowns,
    prerequisites: [],
    notes: [],
    problems: [],
    ok: false,
  };
  const taken = Object.keys(scanned.report).filter((key) => key in head || key in tail);
  if (taken.length)
    throw new Error(
      `a destination's discovery reports ${taken.join(", ")}, which keypin check owns`,
    );
  const report: Report = { ...head, ...scanned.report, ...tail };
  for (const vault of deps.vaults)
    report.notes.push(...(vault.signInNotes?.({ signIn, env: deps.env }) ?? []));
  const targets = new Map<string, PublishTarget>();
  const items = new Map<string, CheckedItem>();
  const kinds = new Map<string, KeyRef["kind"]>();
  const gapsOf = (map: KeysMap | null) =>
    findGaps(scanned.scan, map && found ? { map, text: found.text } : null, deps.vaults);
  const done = async (gaps: Gaps | null, empty: string | null = null) => {
    if (gaps) {
      report.production = gaps.production;
      report.local = gaps.local;
      report.add = gaps.add;
      report.problems.push(...gaps.problems);
      report.notes.push(...gaps.notes);
    }
    const setup = await prerequisites(
      root,
      scanned,
      [...targets.values()],
      items,
      kinds,
      signIn,
      deps,
    );
    report.prerequisites = setup.map(({ name, status, fix }) => ({ name, status, fix }));
    report.ok = !report.problems.length;
    const all = [...setup.map((p) => p.step), ...steps];
    const counts = scanned.read.map(({ noun, count: n }) => count(n, noun)).join(", ");
    const read = [`read ${counts}`, ...scanned.about].join("; ");
    const fixes = gaps?.fixes ?? [];
    return { report, steps: plan(report, all, fixes, gaps?.addsPin ?? false, empty), read };
  };
  if (!found || !parsed) {
    problem(
      ORDER.map,
      `Create ${MAP_FILE}`,
      [`There's no ${MAP_FILE} in ${folder} or any folder above it.`, "  keypin init"],
      `no ${MAP_FILE} in ${folder} or any folder above it; run keypin init, then keypin check again`,
    );
    return done(gapsOf(null));
  }
  const registry = await loadRegistry(deps.files, registryPath(deps));
  report.registered = registry.projects.includes(root);
  if (!report.registered)
    report.notes.push(
      `${root} isn't registered, so keypin status doesn't list it; run keypin init there`,
    );

  if (!parsed.ok) {
    report.problems.push(...parsed.errors);
    steps.push({
      order: ORDER.map,
      title: `Fix ${found.file}`,
      body: parsed.errors,
      covers: parsed.errors,
    });
    return done(null);
  }
  const map = parsed.map;
  if (!map.keys.length) {
    const empty = `${found.file} maps no keys yet; run keypin import for an env file, and add the TOML below for production`;
    report.problems.push(empty);
    return done(gapsOf(map), empty);
  }

  const entries = map.keys.flatMap((key) =>
    map.environments.flatMap((environment) => {
      const entry = key.environments[environment];
      return entry ? [{ key: key.name, environment, entry }] : [];
    }),
  );
  const users = new Map<string, string[]>();
  const use = (id: string, label: string) => users.set(id, [...(users.get(id) ?? []), label]);

  const refs = distinctRefs(entries.map(({ entry }) => entry.ref));
  for (const vault of deps.vaults)
    report.notes.push(...(vault.itemNotes?.(refs, { signIn, env: deps.env }) ?? []));
  report.notes.push(ITEM_NOTE);
  const lookup = `${count(refs.length, "item")} in ${vaultAccounts(refs, deps.vaults)}, not the values`;
  await out.step(
    `Looking up ${lookup}`,
    async () => {
      for (const ref of refs) {
        kinds.set(refKey(ref), ref.kind);
        items.set(refKey(ref), await checkItem(ref, deps));
      }
    },
    () => {
      const failed = [...items.values()].filter((item) => !item.ok).length;
      return {
        ok: !failed,
        text: failed ? `Couldn't look up ${failed} of ${lookup}` : `Looked up ${lookup}`,
      };
    },
    approval(deps, refs),
  );

  const placeOf = (target: PublishTarget) => checkId(target, deps.destinations);
  for (const { entry } of entries)
    for (const target of entry.publish) targets.set(placeOf(target), target);
  const { publisher, notes } = await publisherFor([...targets.values()], deps, root, false);
  report.notes.push(...notes);
  const destinations = new Map<string, DestinationResult>();
  const accounts = count(targets.size, "account");
  if (targets.size)
    await out.step(
      `Checking ${accounts}`,
      async () => {
        for (const [place, target] of targets) {
          const login = kindOf(deps.destinations, target.to).login(target, publisher);
          destinations.set(place, await checkDestination(place, target, login, publisher, deps));
        }
      },
      () => {
        const failed = [...destinations.values()].filter((d) => !d.ok).length;
        return {
          ok: !failed,
          text: failed ? `${failed} of ${accounts} failed the check` : `Checked ${accounts}`,
        };
      },
    );

  for (const { key, environment, entry } of entries) {
    const name = `${key} (${environment})`;
    const from = items.get(refKey(entry.ref));
    if (!from) throw new Error(`no item check for ${formatReference(entry.ref, deps.vaults)}`);
    use(`item ${refKey(entry.ref)}`, name);
    const reached = entry.publish.map((target) => {
      use(`place ${placeOf(target)}`, name);
      const result = destinations.get(placeOf(target));
      if (!result) throw new Error(`no account check for ${placeOf(target)}`);
      return { ...result, destination: secretKey(target, key, deps.destinations) };
    });
    report.keys.push({
      key,
      environment,
      from: { reference: from.reference, ok: from.ok, problem: from.problem },
      destinations: reached,
    });
  }

  const usedBy = (id: string) => users.get(id)?.join(", ") ?? "unused";
  for (const ref of refs) {
    const item = items.get(refKey(ref));
    if (!item?.problem) continue;
    const by = usedBy(`item ${refKey(ref)}`);
    problem(
      ORDER.item,
      `Fix the vault item ${item.reference}`,
      [sentence(item.problem), `Used by ${by}.`],
      `${item.problem} (${by})`,
      item.signIn ? ref.kind : undefined,
    );
  }
  for (const [place, result] of destinations) {
    if (result.ok) continue;
    const target = targets.get(place);
    const by = usedBy(`place ${place}`);
    const fix = result.fix ? `; fix: ${result.fix}` : "";
    const text = `${place}: ${result.problem}${fix} (${by})`;
    report.problems.push(text);
    steps.push({
      order: ORDER.account,
      title: `Fix the login for ${target ? kindOf(deps.destinations, target.to).where(target) : place}`,
      body: [
        sentence(result.problem ?? "the account check failed"),
        loginLine(result),
        ...(result.fix ? [`Fix: ${sentence(result.fix)}`] : []),
        `Used by ${by}.`,
      ],
      covers: [text],
      to: result.to,
    });
  }
  return done(gapsOf(map));
}
