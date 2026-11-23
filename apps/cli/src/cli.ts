import { messageOf } from "@keypin/core";
import { check } from "./commands/check";
import { publish } from "./commands/publish";
import { rotate } from "./commands/rotate";
import { status } from "./commands/status";
import { unregister } from "./commands/unregister";
import { type Deps, UsageError } from "./deps";
import { errorCode } from "./errors";
import { closeVault } from "./vault";
import { version } from "../../../package.json";

const COMMAND_USAGE: [string, string][] = [
  [
    "check",
    `  keypin check [folder] [--json]
                           report a project without changing it: each mapped item exists, each
                           login reaches the pinned account, every secret a workflow or Worker
                           needs is published there (with the TOML to add when it isn't), and
                           every name an env file sets is declared. Lists the project in
                           keypin status
`,
  ],
  [
    "publish",
    `  keypin publish <VARIABLE> [--profile <name>] [--yes | --plan]
                           check accounts, plan, confirm, then write the key to every destination
                           (default: production, or the last profile); --plan reads the value, prints
                           the plan and the command to approve it, and writes nothing
`,
  ],
  [
    "publish",
    `  keypin publish --all [--profile <name>] [--yes | --plan]
                           the same for every key with destinations, with one plan and one approval
`,
  ],
  [
    "rotate",
    `  keypin rotate <VARIABLE> [--profile <name>] [--yes | --plan]
                           replace a key that has an issuer: create a new key at the provider, save
                           it to 1Password, publish it, then ask before revoking the old key; run it
                           again to continue after a failure or to revoke the old key later; --plan
                           reads the keys, prints the plan and the command to approve it, and changes
                           nothing
`,
  ],
  [
    "rotate",
    `  keypin rotate <VARIABLE> --discard [--profile <name>] [--yes | --plan]
                           throw away an unfinished rotation, whose new key may have leaked: make
                           a fresh key, publish it everywhere, then ask before revoking the
                           discarded one
`,
  ],
  [
    "rotate",
    `  keypin rotate --due [--profile <name>] [--yes]
                           the same for every key that is due and has an issuer and destinations;
                           without a terminal it stops before revoking, and the old key waits for
                           approval. Records the result in .keypin/, never a value
`,
  ],
  [
    "rotate",
    `  keypin rotate --check [--profile <name>]
                           check that --due can run here, without a terminal, and change nothing:
                           for every key --due rotates, due or not, find the item, read the key and
                           the admin key, check the issuer and each destination, and fail if a write
                           would need approval
`,
  ],
  [
    "rotate",
    `  keypin rotate --approve-revoke [<VARIABLE>] [--profile <name>]
                           revoke the old key of each rotation waiting for approval, once every
                           destination has the new key; this is the approval, so no y is asked
`,
  ],
  [
    "status",
    `  keypin status [--json]   every key in every project keypin check, publish or rotate ran in,
                           with problems
`,
  ],
  [
    "status",
    `  keypin status --write    write each of this project's rotated dates to .keypin/status.json,
                           for the hosted console; never a value
`,
  ],
  [
    "unregister",
    `  keypin unregister [folder]
                           stop listing a project in keypin status; its secretspec.toml stays
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
`;

const COMMANDS = new Map<string, (args: string[], deps: Deps) => Promise<number>>([
  ["check", check],
  ["publish", publish],
  ["rotate", rotate],
  ["status", status],
  ["unregister", unregister],
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
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout.write(USAGE);
    return 0;
  }
  try {
    return await command(args, deps);
  } catch (error) {
    if (error instanceof UsageError || errorCode(error)?.startsWith("ERR_PARSE_ARGS")) {
      deps.stderr.write(`keypin ${name}: ${messageOf(error)}\n${usageOf(name)}${MORE}`);
      return 2;
    }
    deps.stderr.write(`keypin ${name}: ${messageOf(error)}\n`);
    return 1;
  } finally {
    await closeVault(deps);
  }
}

const MORE = "keypin --help lists every command.\n";

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
