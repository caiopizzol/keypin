import { describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli";
import { fakeDeps, memoryFiles } from "./fakes";

const map = (uri: string) => `[project]
name = "billing"
revision = "1.0"

[profiles.default]
STRIPE_API_KEY = { description = "Stripe", providers = ["${uri}"] }
`;

describe("vaults keypin doesn't read from secretspec.toml yet", () => {
  test.each([
    ["Infisical", "infisical://app.infisical.com"],
    ["Doppler", "doppler://billing"],
    ["Bitwarden", "bws://"],
    ["AWS Secrets Manager", "awssm://us-east-1"],
  ])("%s is refused by name, and nothing is read", async (name, uri) => {
    const run = fakeDeps({ disk: memoryFiles({ "/work/billing/secretspec.toml": map(uri) }) });
    expect(await cli(["run", "--", "env"], run.deps)).toBe(1);
    expect(run.stderr.text).toBe(
      `keypin run: /work/billing/secretspec.toml: [profiles.default] STRIPE_API_KEY: uses ${uri}; keypin doesn't read ${name} from secretspec.toml yet\n`,
    );
  });
});
