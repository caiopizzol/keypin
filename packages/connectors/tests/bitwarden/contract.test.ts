import { describe } from "vite-plus/test";
import { vaultContract } from "@keypin/core/testing";
import { accessTokenFrom, bitwardenBackend } from "../../src/bitwarden/index";
import {
  bitwardenFetch,
  FAKE_ACCESS_TOKEN,
  type FakeBitwarden,
  memoryStore,
} from "../../src/bitwarden/testing";

const ORGANIZATION = "2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f";
const PLACE = { url: "https://vault.bitwarden.com" };

for (const project of ["billing", "a3c1e2f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b"]) {
  describe(`the vault contract, project ${project}`, () => {
    vaultContract((sentinel) => {
      const fake: FakeBitwarden = {
        organization: ORGANIZATION,
        projects: {
          billing: {
            id: "a3c1e2f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
            secrets: [{ name: "STRIPE_KEY", value: sentinel, note: "rotated: 2026-10-01" }],
          },
        },
      };
      const store = memoryStore();
      const scope = { kind: "bitwarden" as const, ...PLACE, project };
      return {
        vault: bitwardenBackend(
          accessTokenFrom({ BWS_ACCESS_TOKEN: FAKE_ACCESS_TOKEN }),
          bitwardenFetch(fake, store),
        ),
        ref: { ...scope, name: "STRIPE_KEY" },
        scope,
        effects: store.effects,
        refuseWrites: () => {
          const billing = fake.projects.billing;
          if (billing) billing.readOnly = true;
        },
        failSignIn: () => {
          fake.refuseLogin = true;
        },
      };
    });
  });
}
