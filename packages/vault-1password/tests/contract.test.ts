import { describe } from "vite-plus/test";
import { vaultContract } from "@keypin/core/testing";
import { onePasswordBackend, type SignInMode } from "../src/index";
import { fakeOnePassword, field, item } from "../src/testing";

const ACCOUNT = "my.1password.com";

const VAULTS: Record<SignInMode, string[]> = {
  desktop: ["Private", "Shared"],
  "service-account": ["Shared"],
};

for (const mode of ["desktop", "service-account"] satisfies SignInMode[]) {
  describe(`the vault contract, signed in with the ${mode}`, () => {
    vaultContract((sentinel) => {
      const [vault = ""] = VAULTS[mode];
      const fake = fakeOnePassword(
        [
          item("stripe key", [
            field("password", "Concealed", sentinel),
            field("rotated", "Date", "2026-10-01"),
          ]),
        ],
        VAULTS[mode],
      );
      const scope = { kind: "1password" as const, account: ACCOUNT, vault };
      return {
        vault: onePasswordBackend(async () => fake.client, mode),
        ref: { ...scope, item: "stripe key", section: null, field: "password" },
        scope,
        effects: fake.effects,
      };
    });
  });
}
