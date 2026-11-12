export const MIN_BUN = "1.4.4";
export const NO_ENV_FILE = "--no-env-file";
export const COMPILED_AUTOLOAD_OFF = "dotenv and bunfig off";
export const COMPILED_REFUSED_ENV = ["BUN_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO"];
const ENV_FILE = "--env-file";

export interface Compiled {
  autoload: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
}

export function selfCommand(bun: string, script: string): string[] {
  return [bun, NO_ENV_FILE, script];
}

export function runtimeProblem(
  bun: string | undefined,
  script: string,
  execArgv: readonly string[],
  compiled?: Compiled,
): string | null {
  if (bun === undefined) return `keypin runs on Bun ${MIN_BUN} or newer, not Node.`;
  if (olderThan(bun, MIN_BUN)) {
    return `keypin needs Bun ${MIN_BUN} or newer, because older Bun can read a keypin.toml wrong, and this is Bun ${bun}. Upgrade Bun, or run it with "bunx bun@${MIN_BUN} ${NO_ENV_FILE} ${script}".`;
  }
  if (compiled) return compiledProblem(compiled);
  if (!execArgv.includes(NO_ENV_FILE)) {
    return `keypin needs Bun started with ${NO_ENV_FILE}, or Bun adds this folder's .env values to every command keypin runs. Run it as "keypin", or as "bun ${NO_ENV_FILE} ${script}".`;
  }
  if (execArgv.some((arg) => arg === ENV_FILE || arg.startsWith(`${ENV_FILE}=`))) {
    return `keypin can't run with Bun's ${ENV_FILE}: Bun would add that file's values to every command keypin runs. Remove ${ENV_FILE} from the command and from BUN_OPTIONS.`;
  }
  return null;
}

function compiledProblem({ autoload, env }: Compiled): string | null {
  if (autoload !== COMPILED_AUTOLOAD_OFF) {
    return "this keypin binary wasn't built by apps/cli/compile.ts, so it may load this folder's .env and bunfig.toml. Build it with that script.";
  }
  const set = COMPILED_REFUSED_ENV.filter((name) => env[name] !== undefined);
  if (set.length) {
    const names = set.join(" and ");
    return `keypin can't run with ${names} set: Bun would let ${set.length === 1 ? "it" : "them"} load code or a debugger into keypin. Unset ${names}.`;
  }
  return null;
}

function olderThan(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map(Number);
  const a = parts(version);
  const b = parts(minimum);
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}
