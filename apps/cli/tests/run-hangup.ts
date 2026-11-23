import { cli } from "../src/cli";
import { launch, onSignals } from "../src/launch";
import { fakeDeps, fakeVault, memoryFiles, SENTINEL } from "./fakes";

const disk = memoryFiles({
  "/work/billing/secretspec.toml": `[project]\nname = "billing"\nrevision = "1.0"\n\n[providers]\nvault = "onepassword://my.1password.com@Private"\n\n[defaults]\nproviders = ["vault"]\n\n[profiles.dev]\nSESSION_SECRET = { description = "SESSION_SECRET", ref = { item = "web dev session secret", field = "password" } }\n`,
});
const backend = fakeVault({ values: { "web dev session secret": SENTINEL } }).vault;
const { deps } = fakeDeps({ disk, backend, deps: { launch, onSignals } });
process.exitCode = await cli(
  ["run", "--", "sh", "-c", "trap '' HUP; echo started; sleep 30"],
  deps,
);
