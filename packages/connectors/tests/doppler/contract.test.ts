import { describe } from "vite-plus/test";
import { vaultContract } from "@keypin/core/testing";
import { dopplerBackend } from "../../src/doppler/index";
import {
  dopplerFetch,
  type FakeDoppler,
  type FakeToken,
  memoryStore,
} from "../../src/doppler/testing";

const TOKENS: Record<string, FakeToken> = {
  "dp.st.prd.contract": {
    type: "service_token",
    project: "billing",
    config: "prd",
    access: "read/write",
  },
  "dp.sa.contract": { type: "service_account", write: true },
};

for (const token of Object.keys(TOKENS)) {
  describe(`the vault contract, signed in with ${token}`, () => {
    vaultContract((sentinel) => {
      const fake: FakeDoppler = {
        workplace: "acme",
        projects: { billing: { prd: { STRIPE_KEY: { value: sentinel } } } },
        tokens: { ...TOKENS },
      };
      const store = memoryStore();
      const scope = {
        kind: "doppler" as const,
        project: "billing",
        config: "prd",
      };
      return {
        vault: dopplerBackend({ token }, dopplerFetch(fake, store)),
        ref: { ...scope, name: "STRIPE_KEY" },
        scope,
        effects: store.effects,
        keepsRotated: false,
        refuseWrites: () => {
          fake.tokens[token] = token.startsWith("dp.st.")
            ? { type: "service_token", project: "billing", config: "prd", access: "read" }
            : { type: "service_account" };
        },
        failSignIn: () => {
          fake.tokens = {};
        },
      };
    });
  });
}
