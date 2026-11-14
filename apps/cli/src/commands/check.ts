import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type Environment,
  findGaps,
  type Fix,
  formatReference,
  type Gaps,
  type KeyRef,
  type KeysMap,
  loadRegistry,
  parseMap,
  type PublishTarget,
  secretKey,
} from "@keypin/core";
import { DESKTOP_APP_MISSING } from "@keypin/vault-1password";
import { type Deps, UsageError } from "../deps";
import { messageOf } from "../errors";
import { type Output, output, tilde } from "../output";
import { registryPath } from "../paths";
import { locateMap, MAP_FILE } from "../project";
import { describeLogin, githubLogin, publisherFor } from "../publisher";
import { type ScanResult, scanProject, type Unknown, usesSecrets } from "../scan";
import { distinctRefs, refKey } from "../vault";

interface ItemResult {
  reference: string;
  ok: boolean;
  problem: string | null;
}

interface DestinationResult {
  destination: string;
  to: PublishTarget["to"];
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

interface Prerequisite {
  name: "GitHub" | "Cloudflare" | "1Password";
  status: "not installed" | "not logged in" | "not checked" | "sign-in failed";
  fix: string;
}

interface Report {
  folder: string;
  map: string | null;
  registered: boolean;
  read: ScanResult["files"] & { notScanned: string[] };
  github: { repo: string | null; login: string | null };
  keys: KeyResult[];
  production: Gaps["production"];
  local: Gaps["local"];
  add: string | null;
  unknown: Unknown[];
  prerequisites: Prerequisite[];
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

  const { report, steps } = await build(folder, deps);
  deps.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : render(report, steps, output(deps.stdout, deps.styled.stdout), deps.home),
  );
  return report.ok ? 0 : 1;
}

interface Step {
  order: number;
  title: string;
  body: string[];
  toml?: string;
  covers: string[];
  to?: PublishTarget["to"];
  service?: Prerequisite["name"];
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

async function build(folder: string, deps: Deps): Promise<{ report: Report; steps: Step[] }> {
  const out = output(deps.stderr, deps.styled.stderr, deps.columns);
  const steps: Step[] = [];
  const problem = (order: number, title: string, body: string[], text: string) => {
    report.problems.push(text);
    steps.push({ order, title, body, covers: [text] });
  };
  let fixes: Fix[] = [];
  let empty: string | null = null;
  const found = await locateMap(deps.files, folder);
  const root = found ? dirname(found.file) : folder;
  const scanned = await scanProject(deps, root);
  const report: Report = {
    folder: root,
    map: found?.file ?? null,
    registered: false,
    read: { ...scanned.files, notScanned: scanned.nested },
    github: { repo: scanned.scan.github.repo, login: scanned.login },
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
  const targets = new Map<string, PublishTarget>();
  const items = new Map<string, ItemResult>();
  const done = async () => {
    const setup = await prerequisites(root, scanned, targets, items, deps);
    report.prerequisites = setup.map(({ name, status, fix }) => ({ name, status, fix }));
    finish(report);
    return { report, steps: plan(report, [...setup.map((p) => p.step), ...steps], fixes, empty) };
  };
  const gaps = (map: KeysMap | null) => {
    const result = findGaps(scanned.scan, map && found ? { map, text: found.text } : null);
    report.production = result.production;
    report.local = result.local;
    report.add = result.add;
    report.problems.push(...result.problems);
    report.notes.push(...result.notes);
    fixes = result.fixes;
  };
  if (!found) {
    problem(
      ORDER.map,
      `Create ${MAP_FILE}`,
      [`There's no ${MAP_FILE} in ${folder} or any folder above it.`, "  keypin init"],
      `no ${MAP_FILE} in ${folder} or any folder above it; run keypin init, then keypin check again`,
    );
    gaps(null);
    return done();
  }
  const registry = await loadRegistry(deps.files, registryPath(deps));
  report.registered = registry.projects.includes(root);
  if (!report.registered)
    report.notes.push(
      `${root} isn't registered, so keypin status doesn't list it; run keypin init there`,
    );

  const parsed = parseMap(found.text, found.file);
  if (!parsed.ok) {
    report.problems.push(...parsed.errors);
    steps.push({
      order: ORDER.map,
      title: `Fix ${found.file}`,
      body: parsed.errors,
      covers: parsed.errors,
    });
    return done();
  }
  const map = parsed.map;
  if (!map.keys.length) {
    empty = `${found.file} maps no keys yet; run keypin import for an env file, and add the TOML below for production`;
    report.problems.push(empty);
    gaps(map);
    return done();
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
  report.notes.push(ITEM_NOTE);
  const lookup = `${count(refs.length, "item")} in 1Password account ${[...new Set(refs.map((ref) => ref.account))].join(", ")}, not the values`;
  await out.step(
    `Looking up ${lookup}`,
    async () => {
      for (const ref of refs) items.set(refKey(ref), await checkItem(ref, deps));
    },
    () => {
      const failed = [...items.values()].filter((item) => !item.ok).length;
      return {
        ok: !failed,
        text: failed ? `Couldn't look up ${failed} of ${lookup}` : `Looked up ${lookup}`,
      };
    },
    "1Password may be asking you to approve keypin",
  );

  for (const { entry } of entries)
    for (const target of entry.publish) targets.set(placeOf(target), target);
  const publisher = {
    ...(await publisherFor([...targets.values()], deps, folder)),
    refreshLogins: false,
  };
  const wrangler = [...targets.values()].some((t) => t.to === "cloudflare-worker")
    ? await deps.wranglerLoginFile()
    : null;
  if (wrangler !== null)
    report.notes.push(
      `the wrangler login is an OAuth token stored in plain text in ${wrangler}; wrangler logout removes it`,
    );
  const destinations = new Map<string, DestinationResult>();
  const accounts = count(targets.size, "account");
  if (targets.size)
    await out.step(
      `Checking ${accounts}`,
      async () => {
        for (const [place, target] of targets) {
          const login =
            target.to === "github-actions"
              ? describeLogin(publisher.githubLogin)
              : `the wrangler login${wrangler === null ? "" : ` in ${wrangler}`}`;
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
    if (!from) throw new Error(`no item check for ${formatReference(entry.ref)}`);
    use(`item ${refKey(entry.ref)}`, name);
    const reached = entry.publish.map((target) => {
      use(`place ${placeOf(target)}`, name);
      const result = destinations.get(placeOf(target));
      if (!result) throw new Error(`no account check for ${placeOf(target)}`);
      return { ...result, destination: secretKey(target, key) };
    });
    report.keys.push({ key, environment, from, destinations: reached });
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
      title: `Fix the login for ${target ? where(target) : place}`,
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
  gaps(map);
  return done();
}

const INTEGRATION =
  "the 1Password desktop app, with Settings → Developer → Integrate with other apps selected";

async function prerequisites(
  root: string,
  scanned: ScanResult,
  targets: Map<string, PublishTarget>,
  items: Map<string, ItemResult>,
  deps: Deps,
): Promise<(Prerequisite & { step: Step })[]> {
  const list: (Prerequisite & { step: Step })[] = [];
  const add = (p: Prerequisite, title: string, body: string[]) =>
    list.push({ ...p, step: { order: ORDER.setup, title, body, covers: [], service: p.name } });
  const to = (kind: PublishTarget["to"]) => [...targets.values()].some((t) => t.to === kind);
  if (usesSecrets(scanned.scan.workflows) || to("github-actions")) {
    const login = await githubLogin(deps, root);
    const status = await deps.ghLogin(login);
    const command = "gh auth login --hostname github.com";
    const signIn = `${command}${login ? `, signing in as ${login}` : ""}`;
    const body = [`  ${command}`, ...(login ? [`Sign in as ${login}.`] : [])];
    if (status === "not installed")
      add(
        { name: "GitHub", status, fix: `install gh (https://cli.github.com), then run ${signIn}` },
        "Install gh and sign in to GitHub",
        ["Install gh from https://cli.github.com, then run:", ...body],
      );
    else if (status === "not logged in")
      add({ name: "GitHub", status, fix: `run ${signIn}` }, "Sign in to GitHub", body);
  }
  if (
    (scanned.files.wrangler.length || to("cloudflare-worker")) &&
    !(await deps.wranglerLoginFile())
  )
    add(
      { name: "Cloudflare", status: "not logged in", fix: "run wrangler login" },
      "Sign in to Cloudflare",
      ["  wrangler login"],
    );
  if (!items.size)
    add(
      { name: "1Password", status: "not checked", fix: `keypin needs ${INTEGRATION}` },
      "Set up 1Password",
      [`keypin needs ${INTEGRATION}.`],
    );
  else if ([...items.values()].some((item) => item.problem?.includes(NO_ACCOUNT)))
    add({ name: "1Password", status: "sign-in failed", fix: ACCOUNT_FIX }, SIGN_IN, [
      sentence(ACCOUNT_FIX),
    ]);
  else if ([...items.values()].some((item) => item.problem?.includes(DESKTOP_APP_MISSING)))
    add({ name: "1Password", status: "sign-in failed", fix: INSTALL_FIX }, SIGN_IN, [
      sentence(INSTALL_FIX),
    ]);
  else if ([...items.values()].some((item) => item.problem?.includes("sign-in failed")))
    add(
      {
        name: "1Password",
        status: "sign-in failed",
        fix: `check ${INTEGRATION}, and that it's unlocked`,
      },
      SIGN_IN,
      [`Check ${INTEGRATION}, and that it's unlocked.`],
    );
  return list;
}

const SIGN_IN = "Sign in to 1Password";
const NO_ACCOUNT = "has no account with this sign-in address or ID";
const INSTALL_FIX =
  "install the 1Password desktop app, or on a server or CI use a 1Password service account (docs/service-account.md)";
const ACCOUNT_FIX = `set account under [1password] in ${MAP_FILE} to a sign-in address or account ID the 1Password app lists, under Settings → Accounts`;

function loginLine(result: DestinationResult): string {
  const signedIn = result.publisher === null ? "" : `, signed in as ${result.publisher}`;
  const reaches =
    result.reached === null || result.reached === result.pinned
      ? ""
      : `, and it reaches ${result.reached}`;
  return `${MAP_FILE} pins ${result.pinned}; the login is ${result.login}${signedIn}${reaches}.`;
}

function finish(report: Report): Report {
  report.ok = !report.problems.length;
  return report;
}

async function checkItem(ref: KeyRef, deps: Deps): Promise<ItemResult> {
  const reference = formatReference(ref);
  try {
    await deps.vault().itemIds(ref);
    return { reference, ok: true, problem: null };
  } catch (error) {
    return { reference, ok: false, problem: messageOf(error) };
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

function placeOf(target: PublishTarget): string {
  return target.to === "cloudflare-worker"
    ? `cloudflare-worker:${target.account}/${target.worker}`
    : `github-actions:${target.repo.toLowerCase()}${target.environment === undefined ? "" : `/environments/${target.environment.toLowerCase()}`}`;
}

function plan(report: Report, found: Step[], fixes: Fix[], empty: string | null): Step[] {
  const steps: Step[] = [];
  const signIn = found.find((step) => step.title === SIGN_IN);
  const github = found.find((step) => step.service === "GitHub");
  for (const step of found) {
    const signs =
      step.order === ORDER.item && step.covers.every((c) => c.includes("sign-in failed"));
    if (github && step.order === ORDER.account && step.to === "github-actions")
      github.covers.push(...step.covers);
    else if (!signIn || !signs) steps.push(step);
    else {
      signIn.covers.push(...step.covers);
      for (const line of step.body.slice(0, 1))
        if (!signIn.body.includes(line)) signIn.body.push(line);
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
    all(
      ORDER.import,
      `Move ${files.length === 1 ? `${files[0]}'s` : "env-file"} keys into 1Password`,
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
  const overlaps =
    imports.length > 0 &&
    (/^\[1password\]$/m.test(report.add ?? "") || add.some((fix) => imported.has(fix.key)));
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

function render(report: Report, steps: Step[], out: Output, home: string): string {
  const { bold, dim, mark } = out;
  const { env, wrangler, workflows, notScanned } = report.read;
  const github = report.github.repo ? `; GitHub ${report.github.repo}` : "";
  const read = `read ${count(env.length, "env file")}, ${count(wrangler.length, "wrangler config")}, ${count(workflows.length, "workflow")}${github}`;
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

function sentence(text: string): string {
  const first = /^(?!keypin\b|gh\b|wrangler\b)[a-z]+\b(?![./:])/.test(text)
    ? `${text[0]?.toUpperCase()}${text.slice(1)}`
    : text;
  return /[.:]$/.test(first) ? first : `${first}.`;
}

function where(target: PublishTarget): string {
  return target.to === "cloudflare-worker"
    ? `the Worker ${target.worker}`
    : `${target.repo}${target.environment === undefined ? "" : ` (environment ${target.environment})`}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
