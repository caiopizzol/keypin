import { check } from "./commands/check";
import { importEnv } from "./commands/import";
import { init } from "./commands/init";
import { publish } from "./commands/publish";
import { run } from "./commands/run";
import { status } from "./commands/status";
import { unregister } from "./commands/unregister";
import { type Deps, UsageError } from "./deps";
import { errorCode, messageOf } from "./errors";
import { version } from "../../../package.json";

const COMMAND_USAGE: [string, string][] = [
  [
    "init",
    `  keypin init [folder]     register a project and write a keypin.toml template
`,
  ],
  [
    "unregister",
    `  keypin unregister [folder]
                           stop listing a project; its keypin.toml stays
`,
  ],
  [
    "status",
    `  keypin status [--json]   every key in every registered project, with problems
`,
  ],
  [
    "check",
    `  keypin check [folder] [--json]
                           report a project without writing anything: each mapped item exists,
                           each login reaches the pinned account, every secret a workflow or
                           Worker needs is published there (with the TOML to add when it isn't),
                           and every name an env file sets is mapped
`,
  ],
  [
    "import",
    `  keypin import <env-file> [NAME...] [--env <name>] --vault <vault> [--account <sign-in address>] [--yes]
                           move an env file's values into new 1Password items and map them for one
                           environment (default: the first, dev): only the named variables, or every
                           one; the account is the map's, or --account when there's no map yet. It
                           never overwrites an item or a reference, so --yes is enough to approve it.
                           The file stays.
`,
  ],
  [
    "run",
    `  keypin run [--env <name>] [--only NAME[,NAME]] -- <command>
                           run a command with one environment's keys (default: the first, dev),
                           or only the named ones
`,
  ],
  [
    "publish",
    `  keypin publish <VARIABLE> [--env <name>] [--yes | --plan]
                           check accounts, plan, confirm, then write the key to every destination
                           (default environment: the last, prod); --plan reads the value, prints
                           the plan and the command to approve it, and writes nothing
`,
  ],
  [
    "publish",
    `  keypin publish --all [--env <name>] [--yes | --plan]
                           the same for every key with destinations, with one plan and one approval
`,
  ],
];

export const USAGE = `Usage:
${COMMAND_USAGE.map(([, text]) => text).join("")}  keypin --version         print the version

Exit codes:
  0  done
  1  failed, or status or check found a problem
  2  usage error
  3  stopped for approval: run the printed command in a terminal and answer y;
     --plan exits 3 whenever the plan would write (routine or not), 0 when there's nothing to write
  keypin run exits 1 if it can't start the command, then with the command's own code.
`;

const COMMANDS = new Map<string, (args: string[], deps: Deps) => Promise<number>>([
  ["init", init],
  ["unregister", unregister],
  ["status", status],
  ["check", check],
  ["import", importEnv],
  ["run", run],
  ["publish", publish],
]);

export async function cli(argv: string[], deps: Deps): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    (name === undefined ? deps.stderr : deps.stdout).write(USAGE);
    return name === undefined ? 2 : 0;
  }
  if (name === "--version" || name === "-v") {
    deps.stdout.write(`${version}\n`);
    return 0;
  }
  const command = COMMANDS.get(name);
  if (!command) {
    const near = suggestion(name);
    const hint = near === undefined ? "" : ` Did you mean ${near}?`;
    deps.stderr.write(`keypin: unknown command "${name}".${hint}\n${MORE}`);
    return 2;
  }
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (own.includes("--help") || own.includes("-h")) {
    deps.stdout.write(USAGE);
    return 0;
  }
  try {
    if (VAULT_COMMANDS.has(name)) deps.signIn();
    return await command(args, deps);
  } catch (error) {
    if (error instanceof UsageError || errorCode(error)?.startsWith("ERR_PARSE_ARGS")) {
      deps.stderr.write(`keypin ${name}: ${messageOf(error)}\n${usageOf(name)}${MORE}`);
      return 2;
    }
    deps.stderr.write(`keypin ${name}: ${messageOf(error)}\n`);
    return 1;
  }
}

const MORE = "keypin --help lists every command.\n";
const VAULT_COMMANDS = new Set(["status", "check", "import", "run", "publish"]);

function usageOf(name: string): string {
  return COMMAND_USAGE.filter(([command]) => command === name)
    .map(([, text]) => text)
    .join("");
}

function suggestion(typed: string): string | undefined {
  const most = typed.length <= 4 ? 1 : 2;
  const near = [...COMMANDS.keys()].filter(
    (command) => command.startsWith(typed) || distance(typed, command) <= most,
  );
  return near.length === 1 ? near[0] : undefined;
}

function distance(a: string, b: string): number {
  const far = a.length + b.length;
  const rows = Array.from({ length: a.length + 2 }, (_, i) =>
    Array.from({ length: b.length + 2 }, (_, j) =>
      i === 0 || j === 0 ? far : i === 1 ? j - 1 : j === 1 ? i - 1 : 0,
    ),
  );
  const at = (i: number, j: number) => rows[i]?.[j] ?? far;
  const lastRow = new Map<string, number>();
  for (let i = 1; i <= a.length; i++) {
    let lastColumn = 0;
    for (let j = 1; j <= b.length; j++) {
      const k = lastRow.get(b[j - 1] ?? "") ?? 0;
      const l = lastColumn;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      if (cost === 0) lastColumn = j;
      const row = rows[i + 1];
      if (row) {
        row[j + 1] = Math.min(
          at(i, j) + cost,
          at(i + 1, j) + 1,
          at(i, j + 1) + 1,
          at(k, l) + (i - k - 1) + 1 + (j - l - 1),
        );
      }
    }
    lastRow.set(a[i - 1] ?? "", i);
  }
  return at(a.length + 1, b.length + 1);
}
