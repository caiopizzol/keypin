import { describe, expect, test } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { ElevenLabsIssuer } from "../../src/elevenlabs/index";
import { type FakeElevenLabs, elevenlabsFetch, memoryWorld } from "../../src/elevenlabs/testing";

const VAULT = "sk_in_the_vault_key_7d2a";
const ACCOUNTS = [{ id: "sa_app", name: "app" }];

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `sk_admin_${sentinel}`;
    const fake: FakeElevenLabs = {
      admin,
      valuePrefix: `sk_${sentinel}_`,
      accounts: ACCOUNTS,
      world: memoryWorld([{ account: "sa_app", keyId: "key_old", name: "prod", value: VAULT }]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new ElevenLabsIssuer({
        admin: async () => new Secret(admin),
        fetch: elevenlabsFetch(fake),
      }),
      current: new Secret(VAULT),
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});

describe("the fake ElevenLabs", () => {
  test("never hands out a key ID or value twice, even after another key is revoked", async () => {
    const issuer = new ElevenLabsIssuer({
      admin: async () => new Secret("sk_admin_fake_0000"),
      fetch: elevenlabsFetch({
        admin: "sk_admin_fake_0000",
        valuePrefix: "sk_fake_",
        accounts: ACCOUNTS,
        world: memoryWorld([{ account: "sa_app", keyId: "key_old", name: "prod", value: VAULT }]),
        effect: () => undefined,
      }),
    });
    expect((await issuer.checkAccount(null, new Secret(VAULT))).ok).toBe(true);
    const first = await issuer.create("first");
    expect(await issuer.revoke("sa_app/key_old")).toBe("revoked");
    const second = await issuer.create("second");
    expect(second.id).not.toBe(first.id);
    expect(second.secret.equals(first.secret)).toBe(false);
  });
});
