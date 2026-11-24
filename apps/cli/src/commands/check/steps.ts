import { type Fix, type KeyRef, type ProviderLines, sentence } from "@keypin/core";
import { MAP_FILE } from "../../project";
import { type Report } from "./report";

export interface Step {
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

export const ORDER = {
  setup: 0,
  map: 1,
  tracked: 2,
  environments: 3,
  providers: 4,
  import: 5,
  item: 6,
  add: 7,
  edit: 8,
  account: 9,
  publish: 10,
  last: 11,
} as const;

export function plan(
  report: Report,
  found: Step[],
  fixes: Fix[],
  providers: ProviderLines | null,
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
      `Add a profile to ${MAP_FILE}`,
      [fix],
      [
        `${sentence(fix.why)} ${sentence(fix.at).slice(0, -1)}:`,
        `  ${fix.line}`,
        "keypin publish uses production, or the last profile.",
      ],
    );
  const imports = of("import").filter((fix) => !report.ok || report.problems.includes(fix.text));
  if (imports.length) {
    const files = [...new Set(imports.map((fix) => fix.file))];
    all(
      ORDER.import,
      `Move ${files.length === 1 ? `${files[0]}'s` : "env-file"} keys into your vault`,
      imports,
      [
        ...imports.flatMap((fix) => [
          sentence(fix.why),
          ...fix.commands.map((command) => `  ${command}`),
          ...(fix.caveat ? [sentence(fix.caveat)] : []),
        ]),
        "Leave out a name that isn't a key: secretspec import copies only declared names, and the file stays.",
      ],
    );
  }
  const add = of("add");
  const imported = new Set(imports.flatMap((fix) => fix.names));
  const overlaps = imports.length > 0 && add.some((fix) => imported.has(fix.key));
  if (providers && (imports.length || report.add !== null)) steps.push(providersStep(providers));
  if (report.add !== null)
    all(
      ORDER.add,
      `Add the production keys to ${MAP_FILE}`,
      add,
      [
        ...add.map((fix) => sentence(fix.why)),
        ...(overlaps ? [AFTER_IMPORT] : []),
        pasteOrAdd(report.add),
      ],
      report.add,
    );
  const settings = of("setting");
  if (settings.length)
    all(ORDER.add, "Read IDs as variables, not secrets", settings, [
      ...settings.map((fix) => sentence(fix.line)),
      "These look like IDs, not keys, so they needn't be secrets. Or add them to [tool.keypin] ignore.",
    ]);
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
        title: "Declare a key",
        body: [`${report.map} declares no keys yet.`, "  secretspec add --help"],
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

export function providersStep({ toml, existing }: ProviderLines): Step {
  return {
    order: ORDER.providers,
    title: `Name the vault in ${MAP_FILE}`,
    body: [
      `A secret's provider in ${MAP_FILE} names its vault, so secretspec, CI and the console find it there.`,
      ...(existing.length
        ? [`${MAP_FILE} already has ${existing.join(" and ")}; add the lines under it.`]
        : []),
      pasteOrAdd(toml),
    ],
    toml,
    covers: [],
  };
}

function pasteOrAdd(toml: string): string {
  return /<[^<>]*>/.test(toml) ? PASTE : ADD;
}

export const PASTE =
  "Replace each <...> with the real value; keypin rejects a secretspec.toml that still has one:";

export const ADD = `Add this at the end of ${MAP_FILE}:`;

export const AFTER_IMPORT = `If you ran the commands above, run keypin check again for this TOML instead; secretspec add changes ${MAP_FILE}.`;
