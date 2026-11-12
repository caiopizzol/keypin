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

export const USAGE = `Usage:
  keypin init [folder]     register a project and write a keypin.toml template
  keypin unregister [folder]
                           stop listing a project; its keypin.toml stays
  keypin status [--json]   every key in every registered project, with problems
  keypin check [folder] [--json]
                           report a project without writing anything: each mapped item exists,
                           each login reaches the pinned account, every secret a workflow or
                           Worker needs is published there (with the TOML to add when it isn't),
                           and every name an env file sets is mapped
  keypin import <env-file> [NAME...] [--env <name>] --vault <vault> [--account <sign-in address>] [--yes]
                           move an env file's values into new 1Password items and map them for one
                           environment (default: the first, dev): only the named variables, or every
                           one; the account is the map's, or --account when there's no map yet. It
                           never overwrites an item or a reference, so --yes is enough to approve it.
                           The file stays.
  keypin run [--env <name>] [--only NAME[,NAME]] -- <command>
                           run a command with one environment's keys (default: the first, dev),
                           or only the named ones
  keypin publish <VARIABLE> [--env <name>] [--yes | --plan]
                           check accounts, plan, confirm, then write the key to every destination
                           (default environment: the last, prod); --plan reads the value, prints
                           the plan and the command to approve it, and writes nothing
  keypin publish --all [--env <name>] [--yes | --plan]
                           the same for every key with destinations, with one plan and one approval
  keypin --version         print the version

Exit codes:
  0  done
  1  failed, or status or check found a problem
  2  usage error
  3  stopped for approval: run the printed command in a terminal and type yes;
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
    deps.stderr.write(`keypin: unknown command "${name}"\n${USAGE}`);
    return 2;
  }
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (own.includes("--help") || own.includes("-h")) {
    deps.stdout.write(USAGE);
    return 0;
  }
  try {
    return await command(args, deps);
  } catch (error) {
    if (error instanceof UsageError || errorCode(error)?.startsWith("ERR_PARSE_ARGS")) {
      deps.stderr.write(`keypin ${name}: ${messageOf(error)}\n${USAGE}`);
      return 2;
    }
    deps.stderr.write(`keypin ${name}: ${messageOf(error)}\n`);
    return 1;
  }
}
