import { cli } from "../src/cli";
import { launch, onSignals } from "../src/launch";
import { fakeDeps, fakeVault, memoryFiles, SENTINEL } from "./fakes";

const disk = memoryFiles({
  "/work/billing/keypin.toml": `[1password]\naccount = "my.1password.com"\n\n[keys.SESSION_SECRET]\ndev = "op://Private/web dev session secret/password"\n`,
});
const backend = fakeVault({ values: { "web dev session secret": SENTINEL } }).vault;
const { deps } = fakeDeps({ disk, backend, deps: { launch, onSignals } });
process.exitCode = await cli(
  ["run", "--", "sh", "-c", "trap '' HUP; echo started; sleep 30"],
  deps,
);
