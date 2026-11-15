import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { BASELINE, baselineAt, mentions, problems } from "./check-provider-literals";

const HOW =
  "Move the text into the provider's kind in packages/connectors (DestinationKind, IssuerKind or VaultKind). See docs/development.md#guardrails.";

let root = "";
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keypin-provider-literals-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("mentions", () => {
  test("counts each provider word, in any case", () => {
    expect(
      mentions(
        'const a = "1Password", b = "op://x", c = "INFISICAL", d = "infisical://y", e = "GitHub";',
      ),
    ).toEqual({ "1password": 1, "op://": 1, infisical: 2, github: 1 });
    expect(mentions("onePassword, Cloudflare, wrangler, Resend, Neon, gh auth")).toEqual({
      onepassword: 1,
      cloudflare: 1,
      wrangler: 1,
      resend: 1,
      neon: 1,
      gh: 1,
    });
  });

  test("gh counts only as a word, and op only as op://", () => {
    expect(mentions("const op = high(); ghost(); op.done;")).toEqual({});
  });
});

describe("problems", () => {
  test("the current tree passes", () => {
    const repo = join(import.meta.dirname, "..");
    expect(problems(repo, baselineAt(repo))).toEqual([]);
  });

  test("a file at its baseline passes", () => {
    put("apps/cli/src/commands/import.ts", 'say("into 1Password");');
    expect(problems(root, { "apps/cli/src/commands/import.ts": 1 })).toEqual([]);
  });

  test("a new mention fails", () => {
    put("apps/cli/src/commands/import.ts", 'say("into 1Password, or Infisical");');
    expect(problems(root, { "apps/cli/src/commands/import.ts": 1 })).toEqual([
      `apps/cli/src/commands/import.ts: names a provider 2 times (1password ×1, infisical ×1), more than the 1 in ${BASELINE}. ${HOW}`,
    ]);
  });

  test("a new file with a mention fails", () => {
    put("packages/core/src/vault.ts", 'export const where = "op://Private/item/field";');
    expect(problems(root, {})).toEqual([
      `packages/core/src/vault.ts: names a provider once (op:// ×1). ${HOW}`,
    ]);
  });

  test("a lower count without a baseline update fails", () => {
    put("apps/cli/src/commands/status.ts", 'say("in Infisical");');
    expect(problems(root, { "apps/cli/src/commands/status.ts": 3 })).toEqual([
      `apps/cli/src/commands/status.ts: names a provider once now (infisical ×1), fewer than the 3 in ${BASELINE}. Lower it to 1 so it stays there.`,
    ]);
  });

  test("a file that names no provider any more must leave the baseline", () => {
    put("apps/cli/src/commands/status.ts", 'say("in your vault");');
    expect(problems(root, { "apps/cli/src/commands/status.ts": 3 })).toEqual([
      `apps/cli/src/commands/status.ts: names no provider now. Remove its entry from ${BASELINE} so it stays at zero.`,
    ]);
  });

  test("a deleted file must leave the baseline", () => {
    expect(problems(root, { "apps/cli/src/gone.ts": 2 })).toEqual([
      `apps/cli/src/gone.ts: names no provider now. Remove its entry from ${BASELINE} so it stays at zero.`,
    ]);
  });

  test("start.ts, sign-in.ts, connectors, tests and other files aren't counted", () => {
    for (const path of [
      "apps/cli/src/start.ts",
      "apps/cli/src/sign-in.ts",
      "packages/connectors/src/github/kind.ts",
      "apps/cli/tests/check.test.ts",
      "packages/core/tests/map.test.ts",
      "packages/core/src/notes.md",
    ])
      put(path, 'export const name = "GitHub";');
    expect(problems(root, {})).toEqual([]);
  });

  test("a nested file in commands is counted", () => {
    put("apps/cli/src/commands/deep/where.ts", 'export const name = "wrangler";');
    expect(problems(root, {})).toEqual([
      `apps/cli/src/commands/deep/where.ts: names a provider once (wrangler ×1). ${HOW}`,
    ]);
  });
});
