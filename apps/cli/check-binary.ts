import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../../package.json";

const binary = process.argv[2];
if (!binary) {
  process.stderr.write("usage: bun apps/cli/check-binary.ts <compiled keypin>\n");
  process.exit(2);
}

const repo = resolve(import.meta.dir, "../..");
const folder = await mkdtemp(join(tmpdir(), "keypin-binary-"));
const keypin = join(folder, "keypin");
const failures: string[] = [];

function expect(name: string, ok: boolean, detail: string) {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}\n`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

async function run(args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn([keypin, ...args], {
    cwd: folder,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: folder,
      XDG_CONFIG_HOME: join(folder, "config"),
      XDG_STATE_HOME: join(folder, "state"),
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const ECHO = ["run", "--", "sh", "-c", 'echo "${FAKE_X:-unset}"'];

try {
  await copyFile(binary, keypin);
  await writeFile(join(folder, ".env"), "FAKE_X=leak\n");
  await writeFile(join(folder, "preload.js"), "export {};\n");
  await writeFile(join(folder, "keypin.toml"), '[1password]\naccount = "my.1password.com"\n');

  const bytes = Buffer.from(await Bun.file(keypin).arrayBuffer());
  expect(
    "the binary holds no path into this checkout",
    !bytes.includes(Buffer.from(repo)),
    `it contains ${repo}, so it reads a file from the build machine at run time`,
  );

  const shown = await run(["--version"]);
  expect(
    "--version",
    shown.code === 0 && shown.stdout === `${version}\n`,
    shown.stdout + shown.stderr,
  );

  const help = await run(["--help"]);
  expect("--help", help.code === 0 && help.stdout.startsWith("Usage:"), help.stderr);

  const status = await run(["status"]);
  expect(
    "status with empty config and state folders",
    status.code === 0 && status.stdout.includes("No projects registered"),
    status.stdout + status.stderr,
  );

  const leak = await run(ECHO);
  expect(
    "keypin run doesn't pass the folder's .env",
    leak.code === 0 && leak.stdout === "unset\n",
    `exit ${leak.code}, stdout ${JSON.stringify(leak.stdout)}`,
  );

  for (const [name, value] of [
    ["BUN_OPTIONS", "--env-file=.env"],
    ["BUN_OPTIONS", "--preload ./preload.js"],
    ["BUN_INSPECT", "127.0.0.1:0"],
    ["BUN_INSPECT_CONNECT_TO", "unix:///nowhere"],
  ] as const) {
    const refused = await run(ECHO, { [name]: value });
    expect(
      `${name}=${value} is refused before the command runs`,
      refused.code === 1 &&
        refused.stdout === "" &&
        refused.stderr.includes(`keypin can't run with ${name} set`),
      `exit ${refused.code}, stdout ${JSON.stringify(refused.stdout)}, stderr ${refused.stderr}`,
    );
  }
} finally {
  await rm(folder, { recursive: true, force: true });
}

if (failures.length) {
  process.stderr.write(`\n${failures.join("\n")}\n`);
  process.exit(1);
}
