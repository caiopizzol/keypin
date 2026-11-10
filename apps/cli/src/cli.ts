import { init } from "./commands/init";
import { publish } from "./commands/publish";
import { run } from "./commands/run";
import { status } from "./commands/status";
import { unregister } from "./commands/unregister";
import { type Deps, UsageError } from "./deps";
import { errorCode, messageOf } from "./errors";

export const USAGE = `Usage:
  keypin init [folder]     register a project and write a keypin.toml template
  keypin unregister [folder]
                           stop listing a project; its keypin.toml stays
  keypin status [--json]   every key in every registered project, with problems
  keypin run -- <command>  run a command with this project's dev keys in its environment
  keypin publish <key-id> [--env prod|dev] [--yes]
                           check accounts, plan, confirm, then write the key to every destination
`;

const COMMANDS = new Map<string, (args: string[], deps: Deps) => Promise<number>>([
  ["init", init],
  ["unregister", unregister],
  ["status", status],
  ["run", run],
  ["publish", publish],
]);

export async function cli(argv: string[], deps: Deps): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    (name === undefined ? deps.stderr : deps.stdout).write(USAGE);
    return name === undefined ? 2 : 0;
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
