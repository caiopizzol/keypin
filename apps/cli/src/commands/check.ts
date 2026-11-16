import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkId,
  type Environment,
  findGaps,
  type Fix,
  formatReference,
  type Gaps,
  kindOf,
  type KeyRef,
  type KeysMap,
  loadRegistry,
  messageOf,
  parseMap,
  type Prerequisite,
  type PublishTarget,
  secretKey,
  sentence,
  SignInFailed,
  type SignInReason,
  vaultAccounts,
} from "@keypin/core";
import { type Deps, UsageError } from "../deps";
import { count, type Output, output, tilde } from "../output";
import { registryPath } from "../paths";
import { locateMap, MAP_FILE } from "../project";
import { publisherFor } from "../publisher";
import { type ScanResult, scanProject, type Unknown } from "../scan";
import { approval, mapSignIn, type SignIn } from "../sign-in";
import { distinctRefs, refKey } from "../vault";

interface ItemResult {
  reference: string;
  ok: boolean;
  problem: string | null;
}

interface CheckedItem extends ItemResult {
  signIn: SignInReason | null;
}

interface DestinationResult {
  destination: string;
  to: string;
  login: string;
  publisher: string | null;
  pinned: string;
  reached: string | null;
  ok: boolean;
  problem: string | null;
  fix: string | null;
}

interface KeyResult {
  key: string;
  environment: Environment;
  from: ItemResult;
  destinations: DestinationResult[];
}

type Login = Pick<Prerequisite, "name" | "status" | "fix">;

interface Report {
  folder: string;
  map: string | null;
  registered: boolean;
  read: ScanResult["files"] & { notScanned: string[] };
  [discovered: string]: unknown;
  onePassword: { signIn: SignIn["mode"]; address: string | null } | null;
  keys: KeyResult[];
  production: Gaps["production"];
  local: Gaps["local"];
  add: string | null;
  unknown: Unknown[];
  prerequisites: Login[];
  notes: string[];
  problems: string[];
  ok: boolean;
}

export async function check(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new UsageError("keypin check takes at most one folder");
  const folder = resolve(deps.cwd, positionals[0] ?? ".");
  if (!(await deps.isFolder(folder))) throw new Error(`${folder} isn't a folder`);

  const { report, steps, read } = await build(folder, deps);
  deps.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : render(report, read, steps, output(deps.stdout, deps.styled.stdout), deps.home),
  );
  return report.ok ? 0 : 1;
}

interface Step {
  order: number;
  title: string;
  body: string[];
  toml?: string;
  covers: string[];
  to?: string;
  signIn?: KeyRef["kind"];
  provider?: string;
  coversFailures?: boolean;
}

const ORDER = {
  setup: 0,
  map: 1,
  tracked: 2,
  environments: 3,
  import: 4,
  item: 5,
  add: 6,
  edit: 7,
  account: 8,
  publish: 9,
  last: 10,
} as const;

const ITEM_NOTE =
  "items are looked up in each vault's item list, which holds no values, so no field is checked; keypin run and keypin publish --plan read the fields";

async function build(
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
    ? parseMap(found.text, found.file, deps.destinations, deps.issuers, deps.vaults)
    : null;
  const mapped = parsed?.ok
    ? parsed.map.keys.flatMap((key) =>
        Object.values(key.environments).flatMap((e) => (e ? [e.ref] : [])),
      )
    : [];
  const signIn = mapSignIn(deps, parsed?.ok ? parsed.map : null, mapped);
  const root = found ? dirname(found.file) : folder;
  const scanned = await scanProject(deps, root);
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

async function prerequisites(
  root: string,
  scanned: ScanResult,
  targets: readonly PublishTarget[],
  items: Map<string, CheckedItem>,
  kinds: Map<string, KeyRef["kind"]>,
  signIn: SignIn | null,
  deps: Deps,
): Promise<(Login & { step: Step })[]> {
  const list: (Login & { step: Step })[] = [];
  const add = (provider: string, found: readonly Prerequisite[]) => {
    for (const { name, status, fix, title, body, coversFailures } of found)
      list.push({
        name,
        status,
        fix,
        step: {
          order: ORDER.setup,
          title,
          body: [...body],
          covers: [],
          provider,
          coversFailures,
        },
      });
  };
  for (const kind of deps.destinations)
    if (kind.prerequisites)
      add(
        kind.kind,
        await kind.prerequisites(
          {
            folder: root,
            used: scanned.used.get(kind.kind) ?? false,
            targets: targets.filter((t) => t.to === kind.kind),
          },
          deps,
        ),
      );
  for (const vault of deps.vaults) {
    const own = [...items].filter(([key]) => kinds.get(key) === vault.kind);
    const failures = own.flatMap(([, item]) => (item.signIn ? [item.signIn] : []));
    const use = { items: own.length, allItems: items.size, failures };
    if (vault.prerequisites) add(vault.kind, vault.prerequisites(use, { signIn, env: deps.env }));
  }
  return list;
}

function loginLine(result: DestinationResult): string {
  const signedIn = result.publisher === null ? "" : `, signed in as ${result.publisher}`;
  const reaches =
    result.reached === null || result.reached === result.pinned
      ? ""
      : `, and it reaches ${result.reached}`;
  return `${MAP_FILE} pins ${result.pinned}; the login is ${result.login}${signedIn}${reaches}.`;
}

async function checkItem(ref: KeyRef, deps: Deps): Promise<CheckedItem> {
  const reference = formatReference(ref, deps.vaults);
  try {
    await deps.vault().itemIds(ref);
    return { reference, ok: true, problem: null, signIn: null };
  } catch (error) {
    const signIn = error instanceof SignInFailed ? error.reason : null;
    return { reference, ok: false, problem: messageOf(error), signIn };
  }
}

async function checkDestination(
  place: string,
  target: PublishTarget,
  login: string,
  publisher: Parameters<Deps["destination"]>[1],
  deps: Deps,
): Promise<DestinationResult> {
  const base = { destination: place, to: target.to, login, pinned: target.account };
  try {
    const result = await deps.destination(target, publisher).checkAccount();
    return {
      ...base,
      publisher: result.publisher,
      reached: result.destinationAccount,
      ok: result.ok,
      problem: result.ok ? null : (result.reason ?? "the account check failed"),
      fix: result.ok ? null : (result.fix ?? null),
    };
  } catch (error) {
    return {
      ...base,
      publisher: null,
      reached: null,
      ok: false,
      problem: messageOf(error),
      fix: null,
    };
  }
}

function plan(
  report: Report,
  found: Step[],
  fixes: Fix[],
  addsPin: boolean,
  empty: string | null,
): Step[] {
  const steps: Step[] = [];
  const login = (provider: string | undefined) =>
    provider === undefined
      ? undefined
      : found.find((s) => s.provider === provider && s.coversFailures);
  for (const step of found) {
    const account = step.order === ORDER.account ? login(step.to) : undefined;
    const vault = login(step.signIn);
    if (account) account.covers.push(...step.covers);
    else if (!vault) steps.push(step);
    else {
      vault.covers.push(...step.covers);
      for (const line of step.body.slice(0, 1))
        if (!vault.body.includes(line)) vault.body.push(line);
    }
  }
  const of = <K extends Fix["kind"]>(kind: K) =>
    fixes.filter((fix): fix is Extract<Fix, { kind: K }> => fix.kind === kind);
  const all = (order: number, title: string, list: Fix[], body: string[], toml?: string) =>
    steps.push({ order, title, body, covers: list.map((fix) => fix.text), toml });
  for (const fix of of("tracked"))
    all(ORDER.tracked, `Stop tracking ${fix.file} in git`, [fix], [sentence(fix.text)]);
  for (const fix of of("environments"))
    all(
      ORDER.environments,
      `List an environment in ${MAP_FILE}`,
      [fix],
      [
        `${sentence(fix.why)} ${sentence(fix.at).slice(0, -1)}:`,
        `  ${fix.line}`,
        "keypin run uses the first environment, keypin publish the last.",
      ],
    );
  const imports = of("import").filter((fix) => !report.ok || report.problems.includes(fix.text));
  if (imports.length) {
    const files = [...new Set(imports.map((fix) => fix.file))];
    const vault = imports[0]?.vault ?? "";
    all(
      ORDER.import,
      `Move ${files.length === 1 ? `${files[0]}'s` : "env-file"} keys into ${vault}`,
      imports,
      [
        ...imports.flatMap((fix) => [
          sentence(fix.why),
          `  keypin import ${fix.file} ${fix.names.join(" ")}${fix.options}`,
          ...(fix.caveat ? [sentence(fix.caveat)] : []),
        ]),
        "Leave out a name that isn't a key; it stays in the file.",
      ],
    );
  }
  const add = of("add");
  const imported = new Set(imports.flatMap((fix) => fix.names));
  const overlaps = imports.length > 0 && (addsPin || add.some((fix) => imported.has(fix.key)));
  if (report.add !== null)
    all(
      ORDER.add,
      `Add the production keys to ${MAP_FILE}`,
      add,
      [...add.map((fix) => sentence(fix.why)), ...(overlaps ? [AFTER_IMPORT] : []), PASTE],
      report.add,
    );
  const edits = of("edit");
  if (edits.length)
    all(
      ORDER.edit,
      `Edit ${MAP_FILE}`,
      edits,
      edits.map((fix) => sentence(fix.text)),
    );
  const publish = of("publish");
  if (publish.length) {
    const keys = [...new Set(publish.map((fix) => fix.key))];
    all(
      ORDER.publish,
      keys.length === 1 ? `Publish ${keys[0]}` : `Publish ${keys.length} keys`,
      publish,
      [
        ...publish.map((fix) => sentence(fix.why)),
        ...[...new Set(publish.map((fix) => fix.command))].map((command) => `  ${command}`),
      ],
    );
  }
  if (empty !== null) {
    const next = steps.find((step) => step.order === ORDER.import || step.order === ORDER.add);
    if (next) next.covers.push(empty);
    else
      steps.push({
        order: ORDER.map,
        title: "Map a key",
        body: [`${report.map} maps no keys yet.`, "  keypin import --help"],
        covers: [empty],
      });
  }
  const covered = new Set(steps.flatMap((step) => step.covers));
  for (const text of report.problems)
    if (!covered.has(text))
      steps.push({
        order: ORDER.last,
        title: "Fix a problem",
        body: [sentence(text)],
        covers: [text],
      });
  return steps.sort((a, b) => a.order - b.order);
}

export const PASTE =
  "Replace each <...> with the real value; keypin rejects a map that still has one:";
export const THEN = "Then run keypin check again.";
export const AFTER_IMPORT =
  "If you ran the import above, run keypin check again for this TOML instead; the import wrote some of these tables.";

function render(report: Report, read: string, steps: Step[], out: Output, home: string): string {
  const { bold, dim, mark } = out;
  const { notScanned } = report.read;
  const lines = [`${bold(basename(report.folder))} ${dim(`${report.folder} · ${read}`)}`];
  if (notScanned.length)
    lines.push(dim(`Not scanned (own git repository): ${notScanned.join(", ")}`));
  if (steps.length) {
    lines.push(
      steps.length === 1 ? "1 thing to do:" : `${steps.length} things to do, in this order:`,
    );
    steps.forEach((step, i) => {
      lines.push(bold(`${i + 1} ${step.title}`), ...step.body.map((line) => `  ${line}`));
      if (step.toml !== undefined) lines.push("", step.toml.trimEnd(), "", `  ${THEN}`);
    });
  } else {
    const keys = new Set(report.keys.map((row) => row.key)).size;
    const destinations = report.keys.reduce((n, row) => n + row.destinations.length, 0);
    lines.push(
      `${mark(true)} ${count(keys, "key")}, ${count(destinations, "destination")}. Everything checks out.`,
    );
  }
  const shown = new Set(steps.flatMap((step) => step.covers));
  for (const u of report.unknown) lines.push(dim(`Not checked: ${u.what}; ${u.reason}`));
  for (const note of report.notes)
    if (note !== ITEM_NOTE && !shown.has(note)) lines.push(dim(`Note: ${note}`));
  return tilde(`${lines.join("\n")}\n`, home);
}
