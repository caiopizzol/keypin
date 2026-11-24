import { describe, expect, test } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { OpenRouterIssuer } from "../../src/openrouter/index";
import { type FakeOpenRouter, memoryWorld, openrouterFetch } from "../../src/openrouter/testing";

const VAULT = "sk-or-v1-in-the-vault-key-7d2a";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `sk-or-v1-mgmt-${sentinel}`;
    const fake: FakeOpenRouter = {
      admin,
      valuePrefix: `sk-or-v1-${sentinel}-`,
      world: memoryWorld([{ hash: "hash_old", name: "prod", value: VAULT, limit: 20 }]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new OpenRouterIssuer({
        admin: async () => new Secret(admin),
        fetch: openrouterFetch(fake),
      }),
      current: new Secret(VAULT),
      vaultId: "hash_old",
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});

describe("the fake OpenRouter", () => {
  test("never hands out a hash or value twice, even after another key is revoked", async () => {
    const issuer = new OpenRouterIssuer({
      admin: async () => new Secret("sk-or-v1-mgmt-fake-0000"),
      fetch: openrouterFetch({
        admin: "sk-or-v1-mgmt-fake-0000",
        valuePrefix: "sk-or-v1-fake-",
        world: memoryWorld([{ hash: "hash_old", name: "prod", value: VAULT }]),
        effect: () => undefined,
      }),
    });
    expect((await issuer.checkAccount(null, new Secret(VAULT))).ok).toBe(true);
    const first = await issuer.create("first");
    expect((await issuer.checkAccount(first.id, first.secret)).ok).toBe(true);
    expect(await issuer.revoke("hash_old", first.secret)).toBe("revoked");
    const second = await issuer.create("second");
    expect(second.id).not.toBe(first.id);
    expect(second.secret.equals(first.secret)).toBe(false);
  });
});
