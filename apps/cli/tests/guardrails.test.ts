import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@keypin/core";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const IMPORTS = "eslint(no-restricted-imports)";
const AMBIENT = "keypin(no-ambient)";
const CLOCK = "keypin(no-hidden-clock)";

const cases: Record<string, { code: string; flags: string[] }> = {
  "packages/core/src/issuer.ts": {
    code: 'export { ResendIssuer } from "@keypin/issuer-resend";',
    flags: [IMPORTS],
  },
  "packages/core/src/future.ts": {
    code: 'export * from "@keypin/connectors-github";',
    flags: [IMPORTS],
  },
  "packages/vault-infisical/src/peer.ts": {
    code: 'export { ghToken } from "@keypin/destination-github";',
    flags: [IMPORTS],
  },
  "packages/connectors/github/src/peer.ts": {
    code: 'export * from "@keypin/vault-1password";',
    flags: [IMPORTS],
  },
  "packages/issuer-resend/src/core.ts": {
    code: 'export { isRecord } from "@keypin/core";',
    flags: [],
  },
  "apps/cli/src/publishing.ts": {
    code: 'export { ResendIssuer } from "@keypin/issuer-resend";',
    flags: [IMPORTS],
  },
  "apps/cli/src/commands/publish.ts": {
    code: 'export { credentialsFrom } from "@keypin/vault-infisical";',
    flags: [IMPORTS],
  },
  "apps/cli/src/start.ts": {
    code: 'export { ResendIssuer } from "@keypin/issuer-resend";',
    flags: [],
  },
  "apps/cli/src/sign-in.ts": {
    code: 'export { isAccountId } from "@keypin/vault-1password";',
    flags: [],
  },
  "apps/cli/src/commands/check.ts": {
    code: 'export { CLIENT_ID } from "@keypin/vault-infisical";',
    flags: [],
  },
  "packages/core/src/io.ts": {
    code: 'export { readFile } from "node:fs/promises";\nexport { spawn } from "child_process";\nexport { request } from "node:https";',
    flags: [IMPORTS, IMPORTS, IMPORTS],
  },
  "apps/cli/src/commands/io.ts": {
    code: 'export { readFileSync } from "fs";\nexport { connect } from "node:net";\nexport { $ } from "bun";',
    flags: [IMPORTS, IMPORTS, IMPORTS],
  },
  "apps/cli/src/disk.ts": {
    code: 'export { readFile } from "node:fs/promises";',
    flags: [],
  },
  "packages/core/src/ambient.ts": {
    code: 'export const key = process.env.KEY;\nexport const page = fetch("https://example.com");\nexport const file = Bun.file("x");\nexport const child = Bun.spawn(["ls"]);\nexport const written = Bun.write("x", "y");',
    flags: [AMBIENT, AMBIENT, AMBIENT, AMBIENT, AMBIENT],
  },
  "apps/cli/src/commands/ambient.ts": {
    code: 'export const key = process.env["KEY"];',
    flags: [AMBIENT],
  },
  "apps/cli/src/commands/fetch-param.ts": {
    code: "export const get = (fetch: (url: string) => Promise<Response>) => fetch('https://example.com');",
    flags: [],
  },
  "apps/cli/src/main.ts": {
    code: "export const key = process.env.KEY;\nexport const at = new Date();",
    flags: [],
  },
  "packages/core/src/clock.ts": {
    code: "export const at = new Date();\nexport const ms = Date.now();\nexport const roll = Math.random();\nexport const epoch = new Date(0);",
    flags: [CLOCK, CLOCK, CLOCK],
  },
  "apps/cli/src/commands/clock.ts": {
    code: "export const at = new Date();\nexport const day = (now: () => Date) => new Date(now());",
    flags: [CLOCK],
  },
  "packages/core/src/node.ts": {
    code: 'export { env } from "node:process";\nexport { homedir } from "os";\nexport { randomUUID } from "node:crypto";\nexport { performance } from "perf_hooks";\nexport { lookup } from "node:dns/promises";\nexport { connect } from "node:tls";\nexport { Worker } from "worker_threads";\nexport { createInterface } from "node:readline";\nexport { isatty } from "tty";\nexport { runInNewContext } from "node:vm";\nexport { createSocket } from "dgram";',
    flags: Array<string>(11).fill(IMPORTS),
  },
  "apps/cli/src/commands/node-process.ts": {
    code: 'import process from "node:process";\nexport const key = process.env.KEY;',
    flags: [IMPORTS],
  },
  "packages/core/src/global-this.ts": {
    code: 'export const key = globalThis.process.env.KEY;\nexport const page = globalThis.fetch("https://example.com");\nexport const file = globalThis.Bun.file("x");\nexport const at = globalThis.Date.now();\nexport const roll = globalThis.Math.random();\nexport const id = self.crypto.randomUUID();\nexport const late = new window.Date();',
    flags: Array<string>(7).fill(AMBIENT),
  },
  "packages/core/src/global-destructure.ts": {
    code: "const { Math } = globalThis;\nexport const roll = Math.random();\nconst { Date: Clock } = globalThis;\nexport const at = new Clock();",
    flags: [AMBIENT, AMBIENT],
  },
  "apps/cli/src/commands/global-performance.ts": {
    code: "const { performance: p } = globalThis;\nexport const tick = p.now();",
    flags: [AMBIENT],
  },
  "packages/core/src/global-alias.ts": {
    code: "const g = globalThis;\nexport const ms = g.Date.now();",
    flags: [AMBIENT],
  },
  "apps/cli/src/commands/global-self.ts": {
    code: "const { crypto } = self;\nexport const id = crypto.randomUUID();",
    flags: [AMBIENT],
  },
  "apps/cli/src/commands/alias.ts": {
    code: "export const { env } = process;\nconst p = process;\nexport const key = p.env.KEY;\nconst f = fetch;\nexport const page = f('https://example.com');\nexport const { now } = Date;\nexport const r = Math.random;\nexport const g = globalThis;",
    flags: [AMBIENT, AMBIENT, AMBIENT, CLOCK, CLOCK, AMBIENT],
  },
  "packages/core/src/computed.ts": {
    code: "export const key = process[`env`].KEY;\nexport const at = Date[`now`]();\nexport const roll = Math[`random`]();\nexport const ms = Date['now']();\nexport const { ['random']: random } = Math;",
    flags: [AMBIENT, CLOCK, CLOCK, CLOCK, CLOCK],
  },
  "apps/cli/src/commands/random.ts": {
    code: "export const id = crypto.randomUUID();\nexport const bytes = crypto.getRandomValues(new Uint8Array(4));\nexport const tick = performance.now();",
    flags: [CLOCK, CLOCK, CLOCK],
  },
  "packages/core/src/types-only.ts": {
    code: "type Date = string;\nexport type Day = Date;\nexport const ms = Date.now();\ninterface process { env: string }\nexport type P = process;\nexport const key = process.env;\ndeclare const fetch: (url: string) => Promise<Response>;\nexport const page = fetch('https://example.com');\nexport type F = typeof fetch;",
    flags: [CLOCK, AMBIENT, AMBIENT],
  },
  "apps/cli/src/commands/local.ts": {
    code: "const fetch = (url: string) => url;\nexport const page = fetch('https://example.com');\nexport const get = (process: { env: string }) => process.env;\nexport const epoch = new Date(0);\nexport const wide = Math.max(1, 2);\nexport const day = Date.UTC(2026, 0, 1);\nexport const digest = crypto.subtle.digest('SHA-256', new Uint8Array(1));",
    flags: [],
  },
  "packages/core/src/files.ts": {
    code: "export const temporary = `x.${crypto.randomUUID()}.tmp`;\nexport const bytes = crypto.getRandomValues(new Uint8Array(4));",
    flags: [CLOCK],
  },
};

let temp = "";
let flagged = new Map<string, string[]>();

beforeAll(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "keypin-guardrails-")));
  const checkout = join(temp, "keypin");
  await mkdir(checkout, { recursive: true });
  for (const name of ["package.json", "vite.config.ts", "lint-plugin.ts"])
    await copyFile(join(REPO, name), join(checkout, name));
  await symlink(join(REPO, "node_modules"), join(checkout, "node_modules"));

  for (const [path, { code }] of Object.entries(cases)) {
    await mkdir(dirname(join(checkout, path)), { recursive: true });
    await writeFile(join(checkout, path), code + "\n");
  }

  const lint = spawnSync(
    process.execPath,
    [join(checkout, "node_modules/.bin/vp"), "lint", "-f", "json", ...Object.keys(cases)],
    { cwd: checkout, encoding: "utf8" },
  );
  const report: unknown = JSON.parse(lint.stdout);
  if (!isRecord(report) || !Array.isArray(report.diagnostics))
    throw new Error("vp lint printed no diagnostics list");
  flagged = new Map();
  for (const diagnostic of report.diagnostics) {
    if (!isRecord(diagnostic)) continue;
    const code = String(diagnostic.code);
    if (![IMPORTS, AMBIENT, CLOCK].includes(code)) continue;
    const text = `${String(diagnostic.message)} ${String(diagnostic.help)}`;
    if (!text.includes("docs/development.md#guardrails")) continue;
    const file = relative(checkout, resolve(checkout, String(diagnostic.filename)));
    flagged.set(file, [...(flagged.get(file) ?? []), code]);
  }
}, 30_000);

afterAll(() => rm(temp, { recursive: true, force: true }));

test.each(Object.keys(cases))("%s", (path) => {
  expect((flagged.get(path) ?? []).toSorted()).toEqual(cases[path]?.flags.toSorted());
});
