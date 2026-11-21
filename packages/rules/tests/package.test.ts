import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { destinations, issuers, pulls, vaults } from "@keypin/connectors/rules";
import { parseMap } from "@keypin/core";
import root from "../../../package.json";
import { PACKAGE as FOLDER } from "../pack";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const TSC = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));

const MAPS = [
  `[1password]
account = "my.1password.com"

[keys.RESEND_API_KEY.prod]
from = "op://Private/resend/credential"
pull = [{ by = "github-actions", repo = "acme/web" }]
issuer = { kind = "resend", admin = "op://Private/resend admin/credential", permission = "sending_access" }
publish = [{ to = "cloudflare-worker", account = "0123456789abcdef0123456789abcdef", worker = "web" }]
`,
  `[1password]
account = "my.1password.com"

[keys.GITHUB_TOKEN.prod]
from = "op://Private/gh/token"
publish = [{ to = "github-actions", repo = "acme/web" }]
`,
];

const CONSUMER = `import { envFlag, loadMap, type MapResult, periodDays, publishEnvironment, reaches } from "@keypin/rules";

export const maps: readonly string[] = ${JSON.stringify(MAPS)};

export const results: readonly MapResult[] = maps.map((text) => loadMap(text));

const first = results[0];
if (first?.ok) {
  const environment = publishEnvironment(first.map);
  const entry = first.map.keys[0]?.environments[environment];
  const flag: string = envFlag(environment, "prod");
  const due: number | null | undefined = periodDays("90d");
  const reached: boolean = entry !== undefined && reaches(entry);
  void [flag, due, reached];
}
`;

const COMPILER = {
  strict: true,
  noEmit: true,
  target: "ES2023",
  lib: ["ES2023"],
  types: [],
  skipLibCheck: false,
};

let out = "";
let consumer = "";
let tarball = "";

function run(command: string[], cwd: string): { code: number; output: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "keypin-rules-"));
  const build = run(["bun", "run", "pack"], PACKAGE);
  if (build.code !== 0) throw new Error(build.output);
  const pack = run(["npm", "pack", "--pack-destination", out], FOLDER);
  if (pack.code !== 0) throw new Error(pack.output);
  consumer = join(out, "consumer");
  const scope = join(consumer, "node_modules", "@keypin");
  await mkdir(scope, { recursive: true });
  tarball = join(out, (await readdir(out)).find((name) => name.endsWith(".tgz")) ?? "");
  const extract = run(["tar", "-xzf", tarball, "-C", scope], out);
  if (extract.code !== 0) throw new Error(extract.output);
  await rename(join(scope, "package"), join(scope, "rules"));
  await writeFile(join(consumer, "package.json"), `{ "type": "module" }\n`);
  await writeFile(join(consumer, "index.ts"), CONSUMER);
  await writeFile(
    join(consumer, "print.ts"),
    `import { results } from "./index.ts";\nconsole.log(JSON.stringify(results));\n`,
  );
  await writeFile(
    join(consumer, "change.ts"),
    `import { destinations, issuers, loadMap, pulls, vaults } from "@keypin/rules";
import { maps } from "./index.ts";
pulls.pop();
destinations.length = 0;
vaults.reverse();
issuers[0].parse = () => undefined;
console.log(JSON.stringify(maps.map((text) => loadMap(text))));
`,
  );
}, 60_000);

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("@keypin/rules", () => {
  test("ships at the CLI's version", async () => {
    const packed: unknown = JSON.parse(
      await readFile(join(consumer, "node_modules/@keypin/rules/package.json"), "utf8"),
    );
    expect(packed).toMatchObject({ name: "@keypin/rules", version: root.version });
  });

  test("packs only its built JavaScript, its types and the license", () => {
    const list = run(["tar", "-tzf", tarball], out);
    expect(list.output.trim().split("\n").toSorted()).toEqual([
      "package/LICENSE",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/package.json",
    ]);
  });

  test("its JavaScript imports nothing, from Node or anywhere else", async () => {
    const code = await readFile(join(consumer, "node_modules/@keypin/rules/dist/index.js"), "utf8");
    expect(code).not.toContain("node:");
    expect(code).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
  });

  test.each(["Bundler", "NodeNext"])(
    "a project with only ES2023, no DOM and no Node types type-checks against it (%s)",
    async (resolution) => {
      const name = `tsconfig.${resolution}.json`;
      const module = resolution === "Bundler" ? "ESNext" : "NodeNext";
      await writeFile(
        join(consumer, name),
        JSON.stringify({
          compilerOptions: { ...COMPILER, module, moduleResolution: resolution },
          files: ["index.ts"],
        }),
      );
      expect(run([TSC, "-p", name], consumer)).toEqual({ code: 0, output: "" });
    },
  );

  test("loadMap reads keypin.toml the way the CLI's kinds do", () => {
    const printed = run(["bun", "print.ts"], consumer);
    expect(printed.code).toBe(0);
    const expected = MAPS.map((text) =>
      parseMap(text, "keypin.toml", destinations, issuers, vaults, pulls),
    );
    expect(JSON.parse(printed.output)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(expected.map((result) => result.ok)).toEqual([true, false]);
  });

  test("changing the exported lists doesn't change what loadMap reads", () => {
    const printed = run(["bun", "print.ts"], consumer);
    const changed = run(["bun", "change.ts"], consumer);
    expect(changed.code).toBe(0);
    expect(JSON.parse(changed.output)).toEqual(JSON.parse(printed.output));
  });
});
