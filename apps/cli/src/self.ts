import { delimiter, isAbsolute, resolve, sep } from "node:path";

export interface Self {
  folder: string;
  command: readonly string[];
}

export interface Here {
  full: readonly string[];
  running: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  which: (name: string, path: string) => string | null;
  real: (path: string) => string | null;
  launches: (path: string) => string | null;
}

const RUNNER_BIN = `${sep}node_modules${sep}.bin`;

export function terminalPath(path: string | undefined): string {
  return (path ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir) && !dir.replace(/[\\/]+$/, "").endsWith(RUNNER_BIN))
    .join(delimiter);
}

export function selfFor(here: Here): Self {
  return { folder: shownFolder(here), command: isOnPath(here) ? ["keypin"] : here.full };
}

function isOnPath({ running, env, which, real, launches, cwd }: Here): boolean {
  const found = which("keypin", terminalPath(env.PATH));
  const target = found === null ? null : real(found);
  if (target === null) return false;
  const launched = launches(target);
  const runs = [target, launched === null ? null : real(launched)].filter((run) => run !== null);
  if (!running.some((path) => isAbsolute(path) && runs.includes(real(path) ?? ""))) return false;
  return firstKeypin(env.PATH, cwd, which, real) === target;
}

function firstKeypin(
  path: string | undefined,
  cwd: string,
  which: Here["which"],
  real: Here["real"],
): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    const found = which("keypin", resolve(cwd, dir || "."));
    if (found !== null) return real(found);
  }
  return null;
}

function shownFolder({ cwd, env, real }: Here): string {
  const pwd = env.PWD;
  if (pwd === undefined || !isAbsolute(pwd) || pwd === cwd) return cwd;
  const folder = real(cwd);
  return folder !== null && real(pwd) === folder ? pwd : cwd;
}
