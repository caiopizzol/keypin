import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { COMPILED_AUTOLOAD_OFF } from "./src/runtime";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
type Target = (typeof TARGETS)[number];

export const OUT = join(import.meta.dir, "binaries");
const WASM_READ = "require('path').join(__dirname, 'core_bg.wasm')";

const embedSdkWasm: Bun.BunPlugin = {
  name: "embed @1password/sdk-core's WASM",
  setup(build) {
    build.onLoad({ filter: /@1password[\\/]sdk-core[\\/]nodejs[\\/]core\.js$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      if (!text.includes(WASM_READ)) {
        throw new Error(
          `${args.path} no longer reads core_bg.wasm the way compile.ts expects; update the plugin`,
        );
      }
      return { contents: text.replace(WASM_READ, "require('./core_bg.wasm')"), loader: "js" };
    });
  },
};

function isTarget(name: string): name is Target {
  return TARGETS.some((target) => target === name);
}

async function compile(target: Target): Promise<string> {
  const outfile = join(OUT, `keypin-${target}`);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/main.ts")],
    compile: {
      target: `bun-${target}`,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    define: { KEYPIN_COMPILED: JSON.stringify(COMPILED_AUTOLOAD_OFF) },
    loader: { ".wasm": "file" },
    plugins: [embedSdkWasm],
  });
  if (!result.success) throw new AggregateError(result.logs, `keypin: the ${target} build failed`);
  return outfile;
}

if (import.meta.main) {
  const asked = process.argv.slice(2);
  const unknown = asked.filter((name) => !isTarget(name));
  if (unknown.length) {
    process.stderr.write(`unknown target ${unknown.join(", ")}; use ${TARGETS.join(", ")}\n`);
    process.exit(2);
  }
  await mkdir(OUT, { recursive: true });
  for (const target of asked.length ? asked.filter(isTarget) : TARGETS) {
    process.stdout.write(`${await compile(target)}\n`);
  }
}
