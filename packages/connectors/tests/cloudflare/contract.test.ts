import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { destinationContract, issuerContract } from "@keypin/core/testing";
import { CloudflareIssuer, WorkerSecretDestination } from "../../src/cloudflare/index";
import {
  cloudflareFetch,
  type FakeCloudflare,
  type FakeTokens,
  memoryTokens,
  tokensFetch,
} from "../../src/cloudflare/testing";

const ACCOUNT = "11111111111111111111111111111111";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeCloudflare = { email: "me@example.com", accounts: { [ACCOUNT]: ["billing"] } };
    const cloudflare = cloudflareFetch(fake);
    return {
      destination: new WorkerSecretDestination({
        account: ACCOUNT,
        worker: "billing",
        token: async () => "fake-wrangler-token",
        fetch: cloudflare.fetch,
      }),
      name: "API_KEY",
      effects: cloudflare.effects,
      received: (name) => cloudflare.value(ACCOUNT, "billing", name),
      refuse: () => {
        fake.accounts = {};
      },
      breakWrites: () => {
        fake.failPut = true;
      },
    };
  });
});

const VAULT = "cfut_vaulttokenvaulttokenvaulttoken12345_ab12";
const POLICY = {
  effect: "allow",
  resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
  permission_groups: [{ id: "e086da7e2179491d91ee5f35b3ca210a", name: "Workers Scripts Write" }],
};

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `cfut_${sentinel}`;
    const fake: FakeTokens = {
      admin,
      valuePrefix: `cfut_${sentinel}_`,
      world: memoryTokens([
        { id: "a".repeat(32), name: "deploy", value: VAULT, policies: [POLICY] },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new CloudflareIssuer({
        admin: async () => new Secret(admin),
        fetch: tokensFetch(fake),
      }),
      current: new Secret(VAULT),
      vaultId: "a".repeat(32),
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});
