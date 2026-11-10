import { discover } from "./commands/discover";
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
  keypin discover [folder] [--json]
                           every key name a project uses, local and in the cloud, and a draft map
  keypin run -- <command>  run a command with this project's dev keys in its environment
  keypin publish <key-id> [--env prod|dev] [--yes]
                           check accounts, plan, confirm, then write the key to every destination
  keypin rotate <key-id> [--env prod|dev] [--yes]
                           replace a token with a new one that has the same permissions, publish it,
                           and revoke the old one on the next run
  keypin --version         print the version
`;

const COMMANDS = new Map<string, (args: string[], deps: Deps) => Promise<number>>([
  ["init", init],
  ["unregister", unregister],
  ["status", status],
  ["discover", discover],
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
