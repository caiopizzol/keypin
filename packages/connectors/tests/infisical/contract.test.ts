import { describe } from "vite-plus/test";
import { vaultContract } from "@keypin/core/testing";
import { infisicalBackend } from "../../src/infisical/index";
import { type FakeInfisical, infisicalFetch, memoryStore } from "../../src/infisical/testing";

const PLACE = { url: "https://app.infisical.com", project: "billing" };

for (const path of ["/", "/payments/stripe"]) {
  describe(`the vault contract, secret path ${path}`, () => {
    vaultContract((sentinel) => {
      const key = path === "/" ? "STRIPE_KEY" : `${path}/STRIPE_KEY`;
      const fake: FakeInfisical = {
        projects: { billing: { prod: { [key]: { value: sentinel, rotated: "2026-10-01" } } } },
      };
      const store = memoryStore();
      const scope = { kind: "infisical" as const, ...PLACE, environment: "prod", path };
      return {
        vault: infisicalBackend(
          { clientId: "client-id", clientSecret: "client-secret" },
          infisicalFetch(fake, store),
        ),
        ref: { ...scope, name: "STRIPE_KEY" },
        scope,
        effects: store.effects,
        hold: () => {
          fake.heldByPolicy = [];
        },
        failSignIn: () => {
          fake.refuseLogin = 401;
        },
      };
    });
  });
}
