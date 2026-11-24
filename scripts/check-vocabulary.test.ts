import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { vocabularyProblems } from "./check-vocabulary";

const PAGES = {
  "README.md": "# keypin\n",
  "skills/keypin/SKILL.md": "# keypin\n",
  "docs/guides/publishing.md": "# Publishing\n\nkeypin publishes each key to every destination.\n",
  "apps/cli/tests/recordings/publish/plan.txt": "✓ published\n",
};

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

function problems(changes: Record<string, string> = {}): string[] {
  root = mkdtempSync(join(tmpdir(), "keypin-vocabulary-"));
  for (const [file, text] of Object.entries({ ...PAGES, ...changes })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return vocabularyProblems(root);
}

describe("vocabularyProblems", () => {
  test("keypin's docs and recordings have none", () => {
    expect(vocabularyProblems(join(import.meta.dirname, ".."))).toEqual([]);
  });

  test("words BRAND.md uses for other things pass", () => {
    expect(
      problems({
        "docs/guides/publishing.md":
          "# Publishing\n\nAn API token, a `publish` entry, the config's targets, async records, a map.\n",
      }),
    ).toEqual([]);
  });

  test("each banned word, in any case, names the file, line and the word to use", () => {
    expect(
      problems({
        "docs/guides/publishing.md":
          "# Publishing\n\nkeypin syncs each env var to every sink in the map.\n",
        "README.md": "# keypin\n\nSync ENV VARS from The Map, a manifest.\n",
        "apps/cli/tests/recordings/publish/plan.txt": "✓ synced\n",
      }),
    ).toEqual([
      'README.md:3: say "publish", not "Sync". See BRAND.md#vocabulary.',
      'README.md:3: say "key", not "ENV VARS". See BRAND.md#vocabulary.',
      'README.md:3: say "secretspec.toml", not "manifest". See BRAND.md#vocabulary.',
      'README.md:3: say "secretspec.toml", not "The Map". See BRAND.md#vocabulary.',
      'apps/cli/tests/recordings/publish/plan.txt:1: say "publish", not "synced". See BRAND.md#vocabulary.',
      'docs/guides/publishing.md:3: say "publish", not "syncs". See BRAND.md#vocabulary.',
      'docs/guides/publishing.md:3: say "key", not "env var". See BRAND.md#vocabulary.',
      'docs/guides/publishing.md:3: say "secretspec.toml", not "the map". See BRAND.md#vocabulary.',
      'docs/guides/publishing.md:3: say "destination", not "sink". See BRAND.md#vocabulary.',
    ]);
  });
});
