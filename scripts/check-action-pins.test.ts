import { describe, expect, test } from "vite-plus/test";
import { unpinned } from "./check-action-pins";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

const steps = (...lines: string[]) =>
  `jobs:\n  a:\n    steps:\n${lines.map((line) => `      - ${line}`).join("\n")}\n`;

describe("action pins", () => {
  test("accepts SHA pins and local actions, quoted or not", () => {
    const workflow = steps(
      `uses: actions/checkout@${SHA} # v7.0.1`,
      `uses: "actions/checkout@${SHA}"`,
      `uses: './.github/actions/local'`,
      "run: echo hi",
    );
    expect(unpinned(workflow)).toEqual([]);
  });

  test("rejects tags and branches in every YAML form", () => {
    const workflow = steps(
      "uses: actions/checkout@v7.0.1",
      "{ uses: actions/setup-node@v4 }",
      '"uses": actions/cache@main',
      `uses: actions/checkout@${SHA.slice(0, 7)}`,
    );
    expect(unpinned(workflow)).toEqual([
      "actions/checkout@v7.0.1",
      "actions/setup-node@v4",
      "actions/cache@main",
      "actions/checkout@3d3c42e",
    ]);
  });

  test("checks jobs that call a reusable workflow", () => {
    const workflow = "jobs:\n  call:\n    uses: org/repo/.github/workflows/ci.yml@main\n";
    expect(unpinned(workflow)).toEqual(["org/repo/.github/workflows/ci.yml@main"]);
  });
});
