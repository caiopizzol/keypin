import { describe, expect, test } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { XaiIssuer } from "../../src/xai/index";
import { type FakeXai, memoryWorld, xaiFetch } from "../../src/xai/testing";

const VAULT = "xai-in-the-vault-key-7d2a";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `xai-token-mgmt-${sentinel}`;
    const fake: FakeXai = {
      admin,
      team: "team_1",
      valuePrefix: `xai-${sentinel}-`,
      world: memoryWorld([{ id: "key_old", name: "prod", value: VAULT }]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new XaiIssuer({
        admin: async () => new Secret(admin),
        fetch: xaiFetch(fake),
        sleep: async () => {},
      }),
      current: new Secret(VAULT),
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});

describe("the fake xAI", () => {
  test("never hands out an ID or value twice, even after another key is revoked", async () => {
    const issuer = new XaiIssuer({
      admin: async () => new Secret("xai-token-mgmt-fake"),
      fetch: xaiFetch({
        admin: "xai-token-mgmt-fake",
        team: "team_1",
        valuePrefix: "xai-fake-",
        world: memoryWorld([{ id: "key_old", name: "prod", value: VAULT }]),
        effect: () => undefined,
      }),
      sleep: async () => {},
    });
    expect((await issuer.checkAccount(null, new Secret(VAULT))).ok).toBe(true);
    const first = await issuer.create("first");
    expect(await issuer.revoke("team_1/key_old")).toBe("revoked");
    const second = await issuer.create("second");
    expect(second.id).not.toBe(first.id);
    expect(second.secret.equals(first.secret)).toBe(false);
  });
});
