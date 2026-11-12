import { delimiter, isAbsolute, sep } from "node:path";

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

function isOnPath({ running, env, which, real }: Here): boolean {
  const found = which("keypin", terminalPath(env.PATH));
  const target = found === null ? null : real(found);
  if (target === null) return false;
  return running.some((path) => isAbsolute(path) && real(path) === target);
}

function shownFolder({ cwd, env, real }: Here): string {
  const pwd = env.PWD;
  if (pwd === undefined || !isAbsolute(pwd) || pwd === cwd) return cwd;
  const folder = real(cwd);
  return folder !== null && real(pwd) === folder ? pwd : cwd;
}
