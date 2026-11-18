import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract, vaultContract } from "@keypin/core/testing";
import { AwsIssuer, secretsManagerBackend } from "../../src/aws/index";
import {
  accessKeyJson,
  awsFetch,
  type FakeAws,
  type FakeSecretsManager,
  memorySecrets,
  memoryWorld,
  secretsManagerFetch,
} from "../../src/aws/testing";

const APP_ID = "AKIAAPPAPPAPPAPP0001";
const APP_SECRET = "app/secret/value/0001";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = { id: "AKIAADMINADMINADMIN1", secret: `admin-${sentinel}` };
    const fake: FakeAws = {
      account: "123456789012",
      idPrefix: "AKIANEW",
      valuePrefix: `new-${sentinel}-`,
      world: memoryWorld([
        { ...admin, user: "keypin-admin" },
        { id: APP_ID, secret: APP_SECRET, user: "app" },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new AwsIssuer({
        admin: async () => new Secret(accessKeyJson(admin.id, admin.secret)),
        fetch: awsFetch(fake),
        sleep: async () => {},
      }),
      current: new Secret(APP_SECRET),
      currentId: APP_ID,
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});

const SIGN_IN = { id: "ASIAAPPAPPAPPAPP0001", secret: "sm/secret/0001", token: "session-token-1" };

for (const field of [null, "api_key"]) {
  describe(`the vault contract, ${field === null ? "a plain secret" : "one key of a JSON secret"}`, () => {
    vaultContract((sentinel) => {
      const fake: FakeSecretsManager = {
        account: "123456789012",
        credentials: [SIGN_IN],
        secrets: {
          "us-east-1/prod/stripe": {
            value: field === null ? sentinel : JSON.stringify({ [field]: sentinel, other: "x" }),
          },
        },
      };
      const store = memorySecrets();
      const scope = { kind: "awssm" as const, account: "123456789012", region: "us-east-1" };
      return {
        vault: secretsManagerBackend(
          { credentials: SIGN_IN, source: "the test credentials" },
          { fetch: secretsManagerFetch(fake, store), now: () => new Date("2026-11-14T12:00:00Z") },
        ),
        ref: { ...scope, name: "prod/stripe", field },
        scope,
        effects: store.effects,
        refuseWrites: () => {
          fake.denied = ["PutSecretValue"];
        },
        failSignIn: () => {
          fake.credentials = [];
        },
      };
    });
  });
}
