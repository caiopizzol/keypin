import { describe } from "vite-plus/test";
import { vaultContract } from "@keypin/core/testing";
import { onePasswordBackend, type SignInMode } from "../../src/onepassword/index";
import { fakeOnePassword, field, item } from "../../src/onepassword/testing";

const ACCOUNT = "my.1password.com";
const NO_PERMISSION =
  "An error occurred when processing SDK request: Error { msg: you do not have the right permissions to perform this action: , inner: None }";

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
      let signIn = async () => fake.client;
      const refuse = async (): Promise<never> => {
        throw new Error(NO_PERMISSION);
      };
      return {
        vault: onePasswordBackend(() => signIn(), mode),
        ref: { ...scope, item: "stripe key", section: null, field: "password" },
        scope,
        effects: fake.effects,
        failSignIn: () => {
          signIn = async () => {
            throw new Error("Error { msg: the app is locked, inner: None }");
          };
        },
        ...(mode === "service-account"
          ? {
              refuseWrites: () => {
                fake.client.items.create = refuse;
                fake.client.items.put = refuse;
              },
            }
          : {}),
      };
    });
  });
}
