import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs, stripVTControlCharacters } from "node:util";
import { scenarios, valuesOf } from "./scenarios";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(HERE, "../../../..");
const CHILD = join(HERE, "child.ts");
const PROMPT = "[y/N] ";
const ESC = "\x1b";
const STYLE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const TOKEN = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]|[\\s\\S]`, "gu");
const CONTROL = new RegExp(`^${ESC}\\[([0-9;]*)([A-Za-z])$`);
const REDRAW = `\r${ESC}[2K`;

export interface DriveOptions {
  scenario: string;
  args: string[];
  cols?: number;
  answers?: string[];
  plain?: boolean;
  env?: Record<string, string>;
  keep?: boolean;
}

export interface Drive {
  scenario: string;
  args: string[];
  cols: number;
  exit: number | null;
  raw: string;
  screen: string;
  frames: string[];
  effects: string[];
  files: Record<string, string>;
  leaks: string[];
  overlong: string[];
  sandbox: string;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function setUp(name: string) {
  const scenario = scenarios[name];
  if (!scenario)
    throw new Error(`no scenario "${name}"; scenarios: ${Object.keys(scenarios).join(", ")}`);
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "keypin-verify-")));
  const home = join(sandbox, "home");
  const project = join(sandbox, "billing");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(sandbox, "effects.txt"), "");
  git(project, "init", "-q", "-b", "main");
  if (scenario.git.origin) git(project, "remote", "add", "origin", scenario.git.origin);
  if (scenario.git.account) git(project, "config", "github.account", scenario.git.account);
  for (const [path, text] of Object.entries(scenario.files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  if (scenario.registered) {
    mkdirSync(join(home, ".config/keypin"), { recursive: true });
    writeFileSync(
      join(home, ".config/keypin/registry.json"),
      JSON.stringify({ version: 1, projects: [project], shared: [] }),
    );
  }
  return { scenario, sandbox, home, project };
}

function environment(sandbox: string, home: string, name: string, cols: number) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    GIT_CONFIG_NOSYSTEM: "1",
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LANG: "en_US.UTF-8",
    KEYPIN_VERIFY_SANDBOX: sandbox,
    KEYPIN_VERIFY_SCENARIO: name,
  };
}

export function render(raw: string): string {
  const lines: string[][] = [[]];
  let col = 0;
  const text = raw.replaceAll(STYLE, "");
  for (const token of text.match(TOKEN) ?? []) {
    const line = lines[lines.length - 1] ?? [];
    const control = CONTROL.exec(token);
    if (token === "\n") {
      lines.push([]);
      col = 0;
    } else if (token === "\r") col = 0;
    else if (control) {
      const [, n = "", code] = control;
      if (code === "G") col = Math.max(Number(n || "1") - 1, 0);
      else if (code === "C") col += Number(n || "1");
      else if (code === "D") col = Math.max(col - Number(n || "1"), 0);
      else if (code === "K" && n === "2") line.length = 0;
      else if ((code === "K" || code === "J") && (n === "" || n === "0")) line.length = col;
    } else if (token >= " " || token === "\t") {
      while (line.length < col) line.push(" ");
      line[col++] = token;
    }
  }
  return lines.map((line) => line.join("").trimEnd()).join("\n");
}

function framesOf(raw: string): string[] {
  return raw
    .replaceAll("\r\n", "\n")
    .split(REDRAW)
    .map((frame) => stripVTControlCharacters(frame))
    .filter((frame) => frame && !frame.includes("\n"));
}

function snapshot(project: string, paths: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of paths) {
    try {
      files[path] = readFileSync(join(project, path), "utf8");
    } catch {
      continue;
    }
  }
  return files;
}

export async function drive(options: DriveOptions): Promise<Drive> {
  const cols = options.cols ?? 100;
  const { scenario, sandbox, home, project } = setUp(options.scenario);
  const env = { ...environment(sandbox, home, options.scenario, cols), ...options.env };
  const command = ["bun", "--no-env-file", CHILD, ...options.args];
  const answers = [...(options.answers ?? [])];
  let raw = "";
  let exit: number | null;
  if (options.plain) {
    const result = spawnSync(command[0] ?? "bun", command.slice(1), {
      cwd: project,
      env,
      encoding: "utf8",
      input: answers.map((a) => `${a}\n`).join(""),
      timeout: 60_000,
    });
    raw = `${result.stderr}${result.stdout}`;
    exit = result.status;
  } else {
    let answered = 0;
    const decoder = new TextDecoder();
    const child = Bun.spawn(command, {
      cwd: project,
      env,
      terminal: {
        cols,
        rows: 50,
        data: (terminal, chunk) => {
          raw += decoder.decode(chunk, { stream: true });
          const asked = raw.split(PROMPT).length - 1;
          while (answered < asked) {
            terminal.write(`${answers.shift() ?? ""}\n`);
            answered++;
          }
        },
      },
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    exit = await child.exited;
    clearTimeout(timer);
    await Bun.sleep(50);
  }
  const effects = readFileSync(join(sandbox, "effects.txt"), "utf8").split("\n").filter(Boolean);
  const hide = (text: string) => text.replaceAll(sandbox, "<sandbox>");
  const files = Object.fromEntries(
    Object.entries({
      ...snapshot(project, ["keypin.toml", ".env"]),
      ...snapshot(home, [".config/keypin/registry.json", ".local/state/keypin/state.json"]),
    }).map(([path, text]) => [path, hide(text)]),
  );
  const screen = hide(render(raw));
  const frames = framesOf(raw);
  const result: Drive = {
    scenario: options.scenario,
    args: options.args,
    cols,
    exit,
    raw,
    screen,
    frames,
    effects,
    files,
    leaks: valuesOf(scenario).filter((value) => raw.includes(value)),
    overlong: options.plain ? [] : frames.filter((frame) => frame.length > cols - 1),
    sandbox,
  };
  if (!options.keep) rmSync(sandbox, { recursive: true, force: true });
  return result;
}

function save(result: Drive, out: string): void {
  mkdirSync(out, { recursive: true });
  const { raw, screen, frames, files, ...summary } = result;
  writeFileSync(join(out, "raw.txt"), raw);
  writeFileSync(join(out, "screen.txt"), `${screen}\n`);
  writeFileSync(join(out, "frames.txt"), `${frames.join("\n")}\n`);
  writeFileSync(join(out, "files.json"), `${JSON.stringify(files, null, 2)}\n`);
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

const OPTIONS = {
  scenario: { type: "string", default: "ready" },
  cols: { type: "string", default: "100" },
  answer: { type: "string", multiple: true, default: [] },
  plain: { type: "boolean", default: false },
  "no-color": { type: "boolean", default: false },
  keep: { type: "boolean", default: false },
  out: { type: "string" },
  list: { type: "boolean", default: false },
} satisfies ParseArgsOptionsConfig;

function splitArgs(argv: readonly string[]): { own: string[]; keypin: string[] } {
  const own: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") return { own, keypin: argv.slice(i + 1) };
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0] : undefined;
    const option = Object.entries(OPTIONS).find(([n]) => n === name)?.[1];
    if (!option) return { own, keypin: argv.slice(i) };
    own.push(arg);
    if (option.type === "string" && !arg.includes("=")) own.push(argv[++i] ?? "");
  }
  return { own, keypin: [] };
}

if (import.meta.main) {
  const { own, keypin: keypinArgs } = splitArgs(process.argv.slice(2));
  const { values } = parseArgs({ args: own, options: OPTIONS });
  if (values.list) {
    for (const [name, s] of Object.entries(scenarios))
      process.stdout.write(`${name.padEnd(16)} ${s.about}\n`);
    process.exit(0);
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const label = keypinArgs.join("-").replaceAll(/[^a-zA-Z0-9-]/g, "") || "help";
  const out = resolve(values.out ?? join(REPO, ".verify", `${stamp}-${values.scenario}-${label}`));
  const result = await drive({
    scenario: values.scenario,
    args: keypinArgs,
    cols: Number(values.cols),
    answers: values.answer,
    plain: values.plain,
    keep: values.keep,
    env: values["no-color"] ? { NO_COLOR: "1" } : {},
  });
  save(result, out);
  process.stdout.write(`${result.screen}\n`);
  process.stdout.write(
    `--- exit ${result.exit} · effects ${result.effects.length} · leaks ${result.leaks.length} · overlong frames ${result.overlong.length}\n`,
  );
  for (const line of result.effects) process.stdout.write(`effect: ${line}\n`);
  if (result.leaks.length) process.stdout.write(`LEAK: a vault value reached the terminal\n`);
  if (values.keep) process.stdout.write(`sandbox kept: ${result.sandbox}\n`);
  process.stdout.write(`evidence: ${out}\n`);
  process.exit(result.leaks.length || result.overlong.length ? 1 : 0);
}
