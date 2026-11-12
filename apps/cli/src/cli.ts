import { check } from "./commands/check";
import { discover } from "./commands/discover";
import { importEnv } from "./commands/import";
import { init } from "./commands/init";
import { publish } from "./commands/publish";
import { rotate } from "./commands/rotate";
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
  keypin discover [folder] [--json] [--write]
                           every key name a project uses, local and in the cloud, and a draft map;
                           --write saves the draft as keypin.toml (only when there's none, or the
                           untouched init template) and registers the project
  keypin check [folder] [--json]
                           check a project's map, vault items and logins without writing anything:
                           each item and field exists, each login reaches the pinned account
  keypin import <env-file> [NAME...] --vault <vault> [--account <sign-in address>] [--yes]
                           move an env file's values into new 1Password items and map them: only
                           the named variables, or every one; the account is the map's, or --account
                           when there's no map yet. It never overwrites an item, so --yes is enough
                           to approve it. The file stays.
  keypin run [--env <name>] -- <command>
                           run a command with one environment's keys (default: the first, dev)
  keypin publish <VARIABLE> [--env <name>] [--yes | --plan]
                           check accounts, plan, confirm, then write the key to every destination
                           (default environment: the last, prod); --plan reads the value, prints
                           the plan and the command to approve it, and writes nothing
  keypin publish --all [--env <name>] [--yes | --plan]
                           the same for every key with destinations, with one plan and one approval
  keypin rotate <VARIABLE> [--env <name>] [--yes | --plan]
                           replace a token with a new one that has the same permissions, publish it,
                           and revoke the old one on the next run; --plan reads and checks the tokens,
                           prints this run's plan and the command to approve it, and changes nothing
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
  ["discover", discover],
  ["check", check],
  ["import", importEnv],
  ["run", run],
  ["publish", publish],
  ["rotate", rotate],
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
