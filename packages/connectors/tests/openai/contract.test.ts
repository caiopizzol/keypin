import { describe, expect, test } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { OpenAIIssuer } from "../../src/openai/index";
import { type FakeOpenAI, memoryKeys, openaiFetch } from "../../src/openai/testing";

const BOT = { type: "service_account", id: "svc_bot", name: "billing-bot" } as const;

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `sk-admin-${sentinel}`;
    const fake: FakeOpenAI = {
      admin,
      projectId: "proj_1",
      tokenPrefix: `sk-svcacct-${sentinel}-`,
      keys: memoryKeys([
        { id: "key_old", name: "prod", value: "sk-svcacct-in-the-vault-7d2a", owner: BOT },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new OpenAIIssuer({
        admin: async () => new Secret(admin),
        projectId: "proj_1",
        scopes: [],
        fetch: openaiFetch(fake),
      }),
      current: new Secret("sk-svcacct-in-the-vault-7d2a"),
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});

describe("the fake OpenAI", () => {
  test("never hands out an ID or value twice, even after another key is revoked", async () => {
    const issuer = new OpenAIIssuer({
      admin: async () => new Secret("sk-admin-fake"),
      projectId: "proj_1",
      scopes: [],
      fetch: openaiFetch({
        admin: "sk-admin-fake",
        projectId: "proj_1",
        tokenPrefix: "sk-svcacct-fake-",
        keys: memoryKeys([
          { id: "key_old", name: "prod", value: "sk-svcacct-vault-3b1f", owner: BOT },
        ]),
        effect: () => undefined,
      }),
    });
    const vault = new Secret("sk-svcacct-vault-3b1f");
    expect((await issuer.checkAccount(null, vault)).ok).toBe(true);
    const first = await issuer.create("first");
    expect(await issuer.revoke("svc_bot/key_old")).toBe("revoked");
    const second = await issuer.create("second");
    expect(second.id).not.toBe(first.id);
    expect(second.secret.equals(first.secret)).toBe(false);
  });
});
