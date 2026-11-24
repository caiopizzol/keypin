import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Deps, UsageError } from "../../deps";
import { output } from "../../output";
import { build } from "./build";
import { render } from "./render";

export async function check(args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new UsageError("keypin check takes at most one folder");
  const folder = resolve(deps.cwd, positionals[0] ?? ".");
  if (!(await deps.isFolder(folder))) throw new Error(`${folder} isn't a folder`);

  const { report, steps, read, title } = await build(folder, deps);
  deps.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : render(report, title, read, steps, output(deps.stdout, deps.styled.stdout), deps.home),
  );
  return report.ok ? 0 : 1;
}
