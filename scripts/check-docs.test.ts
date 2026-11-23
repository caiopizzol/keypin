import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { docsProblems, drawsAsChain } from "./check-docs";

const INDEX = "# keypin docs\n\n## Start\n\n- [Install](install.md)\n- [Use](guides/use.md)\n";
const PAGES = {
  "README.md":
    "# keypin\n\n[Install](https://github.com/caiopizzol/keypin/blob/main/docs/install.md#with-npm)\n",
  "docs/README.md": INDEX,
  "docs/install.md": "# Install\n\nLead.\n\n## With `npm`!\n\nSee [Use](guides/use.md).\n",
  "docs/guides/use.md": "# Use\n\n## Step one\n\n[Up](#step-one), [code](../../package.json).\n",
  "docs/development.md": "# Development\n",
  "docs/old.md": "# Old\n\nMoved to [Install](install.md).\n",
  "package.json": "{}\n",
};

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

function problems(changes: Record<string, string | null> = {}): string[] {
  root = mkdtempSync(join(tmpdir(), "keypin-docs-"));
  for (const [file, text] of Object.entries({ ...PAGES, ...changes })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return docsProblems(root);
}

describe("docsProblems", () => {
  test("keypin's docs have none", () => {
    expect(docsProblems(join(import.meta.dirname, ".."))).toEqual([]);
  });

  test("a valid set of docs has none", () => {
    expect(problems()).toEqual([]);
  });

  test("a relative link to a missing file", () => {
    expect(
      problems({ "docs/guides/use.md": "# Use\n\n## Step one\n\n[Gone](../gone.md)\n" }),
    ).toEqual(["docs/guides/use.md links to ../gone.md, which doesn't exist."]);
  });

  test("a link to a missing heading, slugged like GitHub", () => {
    expect(
      problems({
        "docs/install.md": "# Install\n\n## With `npm`!\n\nSee [Use](guides/use.md#step-1).\n",
      }),
    ).toEqual(["docs/install.md links to guides/use.md#step-1, a heading that doesn't exist."]);
    expect(problems({ "docs/guides/use.md": "# Use\n\n## Step one\n\n[Up](#step-two)\n" })).toEqual(
      ["docs/guides/use.md links to #step-two, a heading that doesn't exist."],
    );
  });

  test("README.md and SKILL.md links into the repo on GitHub", () => {
    expect(
      problems({
        "skills/keypin/SKILL.md":
          "[Use](https://github.com/caiopizzol/keypin/blob/main/docs/guides/used.md)\n",
      }),
    ).toEqual([
      "skills/keypin/SKILL.md links to https://github.com/caiopizzol/keypin/blob/main/docs/guides/used.md, which doesn't exist.",
    ]);
    expect(
      problems({
        "README.md":
          "[Install](https://github.com/caiopizzol/keypin/blob/main/docs/install.md#with-yarn)\n",
      }),
    ).toEqual([
      "README.md links to https://github.com/caiopizzol/keypin/blob/main/docs/install.md#with-yarn, a heading that doesn't exist.",
    ]);
  });

  test("a pointer file's <a name> anchors count, but only outside listed pages", () => {
    const old =
      '# Old\n\nMoved to [Install](install.md).\n\n- <a name="npm"></a>[npm](install.md#with-npm)\n';
    expect(problems({ "docs/old.md": old, "README.md": "[npm](docs/old.md#npm)\n" })).toEqual([]);
    expect(
      problems({ "docs/old.md": old, "docs/guides/use.md": "# Use\n\n[npm](../old.md#npm)\n" }),
    ).toEqual([
      "docs/guides/use.md links to ../old.md#npm, which docs/README.md doesn't list, so keypin.dev can't link it.",
    ]);
  });

  test("a query string is not part of the path, and a malformed escape doesn't stop the check", () => {
    expect(
      problems({
        "docs/guides/use.md":
          "# Use\n\n## Step one\n\n[Plain](https://github.com/caiopizzol/keypin/blob/main/docs/install.md?plain=1#with-npm), [Bad](../in%stall.md), [Gone](../gone.md)\n",
      }),
    ).toEqual([
      "docs/guides/use.md links to ../in%stall.md, which has a malformed % escape.",
      "docs/guides/use.md links to ../gone.md, which doesn't exist.",
    ]);
  });

  test("links outside the repo or from its root", () => {
    expect(
      problems({
        "docs/guides/use.md": "# Use\n\n[Up](../../../x.md), [Root](/docs/install.md)\n",
      }),
    ).toEqual([
      "docs/guides/use.md links to ../../../x.md, outside keypin's repo.",
      "docs/guides/use.md links to /docs/install.md; use a path relative to the file.",
    ]);
  });

  test("a listed page that doesn't exist", () => {
    expect(
      problems({ "docs/guides/use.md": null, "docs/install.md": "# Install\n\n## With `npm`!\n" }),
    ).toEqual(["docs/README.md links to guides/use.md, which doesn't exist."]);
  });

  test("a page docs/README.md doesn't list, except development.md and pointers", () => {
    expect(problems({ "docs/new.md": "# New\n" })).toEqual([
      "docs/new.md isn't listed in docs/README.md.",
    ]);
  });

  test("docs/README.md entries keypin.dev can't read", () => {
    expect(
      problems({
        "docs/README.md": `- [Install](install.md)\n${INDEX}- Use\n- [Site](https://keypin.dev)\n- [Guide](https://example.com/guide.md)\n`,
      }),
    ).toEqual([
      "docs/README.md lists pages before its first ## section.",
      "docs/README.md lists install.md twice.",
      "docs/README.md has a list item that isn't one link to a page.",
      "docs/README.md links to https://keypin.dev, not a page in docs/.",
      "docs/README.md links to https://example.com/guide.md, not a page in docs/.",
    ]);
  });

  test("a listed page without one # title first", () => {
    expect(problems({ "docs/guides/use.md": "Intro.\n\n# Use\n" })).toEqual([
      "docs/guides/use.md needs to start with its one # title.",
    ]);
    expect(problems({ "docs/guides/use.md": "# Use\n\n# Again\n" })).toEqual([
      "docs/guides/use.md needs to start with its one # title.",
    ]);
  });

  test("a code block keypin.dev doesn't highlight", () => {
    expect(
      problems({ "docs/guides/use.md": "# Use\n\n```bash\nkeypin run\n```\n\n```\nout\n```\n" }),
    ).toEqual([
      "docs/guides/use.md has a bash code block; keypin.dev highlights toml, sh, yaml, sql, json, mermaid.",
    ]);
  });

  test("a mermaid diagram that isn't one left-to-right chain", () => {
    expect(
      problems({ "docs/guides/use.md": "# Use\n\n```mermaid\nflowchart TD\n  a --> b\n```\n" }),
    ).toEqual([
      'docs/guides/use.md has a mermaid diagram keypin.dev can\'t draw. It draws one "flowchart LR" chain, each line like a["Title<br>detail"] -- label --> b["Title"].',
    ]);
  });
});

describe("drawsAsChain", () => {
  test("one flowchart LR chain, labels defined once", () => {
    expect(
      drawsAsChain('flowchart LR\n  a["Vault<br>keys"] -- reads --> b["keypin"]\n  b --> c\n'),
    ).toBe(true);
    expect(drawsAsChain("flowchart LR\n  b --> c\n  a --> b\n")).toBe(true);
  });

  test("not a branch, a merge, a cycle, a relabel or another shape", () => {
    expect(drawsAsChain("flowchart LR\n  a --> b\n  a --> c\n")).toBe(false);
    expect(drawsAsChain("flowchart LR\n  a --> c\n  b --> c\n")).toBe(false);
    expect(drawsAsChain("flowchart LR\n  a --> b\n  c --> d\n  d --> c\n")).toBe(false);
    expect(drawsAsChain('flowchart LR\n  a["A"] --> b\n  b --> c["C"]\n  c --> a["Z"]\n')).toBe(
      false,
    );
    expect(drawsAsChain("flowchart LR\n  a --> b\n  c --> d\n")).toBe(false);
    expect(drawsAsChain("flowchart LR\n")).toBe(false);
    expect(drawsAsChain("sequenceDiagram\n  a->>b: hi\n")).toBe(false);
  });
});
