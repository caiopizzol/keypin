import { basename, dirname, join } from "node:path";
import type { ProjectReader } from "@keypin/core";
import { describe, expect, test } from "vite-plus/test";
import { workflowDiscovery, type WorkflowHost } from "../../src/github/discovery";

const TOP = "/work/repo";
const MANIFEST = `[project]\nname = "x"\n`;

function readers(project: string, workflow: string, files: Record<string, string> = {}) {
  const disk: Record<string, string> = {
    [`${TOP}/apps/web/secretspec.toml`]: MANIFEST,
    [`${TOP}/apps/billing/secretspec.toml`]: MANIFEST,
    [`${TOP}/.github/workflows/deploy.yml`]: workflow,
    ...files,
  };
  const root = join(TOP, project);
  const reader: ProjectReader = {
    root,
    found: [],
    read: async (path) => disk[join(root, path)] ?? null,
    list: async (folder) => ({
      ok: true,
      entries: Object.keys(disk)
        .filter((path) => dirname(path) === folder)
        .map((path) => ({ name: basename(path), kind: "file" as const })),
    }),
    unknown: () => undefined,
  };
  const unused = async () => ({ ok: false as const, reason: "not read here" });
  const host: WorkflowHost = {
    git: async (_folder, args) =>
      args.join(" ") === "rev-parse --show-toplevel" ? `${TOP}\n` : null,
    githubSecrets: unused,
    organizationSecrets: unused,
    sshHostname: async () => null,
  };
  return workflowDiscovery.readers?.(reader, host, "prod");
}

const deploy = (step: string, job = "") => `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest${job}
    steps:
      - ${step}
`;

describe("the workflows a vault-only rotation lists", () => {
  test("a workflow that runs secretspec run in another app of the repo isn't listed", async () => {
    const workflow = deploy(
      "run: secretspec run --profile prod -- ./deploy.sh\n        working-directory: apps/web",
    );
    expect(await readers("apps/billing", workflow)).toEqual([]);
    expect(await readers("apps/web", workflow)).toEqual([
      { file: "../../.github/workflows/deploy.yml", how: "secretspec run --profile prod" },
    ]);
  });

  test("the job's default folder counts, and a folder below the project counts unless it has its own manifest", async () => {
    const job = "\n    defaults:\n      run:\n        working-directory: ./apps/web/scripts";
    const workflow = deploy("run: secretspec run --profile prod -- ./deploy.sh", job);
    expect(await readers("apps/web", workflow)).toHaveLength(1);
    expect(
      await readers("apps/web", workflow, {
        [`${TOP}/apps/web/scripts/secretspec.toml`]: MANIFEST,
      }),
    ).toEqual([]);
  });

  test.each([
    ["a cd before it", "run: cd apps/web && secretspec run --profile prod -- ./deploy.sh"],
    ["--file", "run: secretspec run --file apps/web/secretspec.toml --profile prod -- ./x"],
    [
      "SECRETSPEC_FILE",
      "run: secretspec run --profile prod -- ./x\n        env:\n          SECRETSPEC_FILE: a.toml",
    ],
    [
      "a folder set by an expression",
      "run: secretspec run --profile prod -- ./x\n        working-directory: ${{ inputs.app }}",
    ],
  ])("a step with %s is listed, saying keypin can't tell its folder", async (_, step) => {
    expect(await readers("apps/billing", deploy(step))).toEqual([
      {
        file: "../../.github/workflows/deploy.yml",
        how: "secretspec run --profile prod, from a folder keypin can't tell",
      },
    ]);
  });
});
