import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { GoogleIssuer, ServiceAccountKeyIssuer } from "../../src/google/index";
import {
  type FakeGoogle,
  fakePrivateKey,
  type FakeIam,
  googleFetch,
  iamFetch,
  iamKeyFile,
  memoryIamWorld,
  memoryWorld,
  serviceAccountJson,
  serviceAccountKeyId,
} from "../../src/google/testing";

const EMAIL = "keypin@acme-admin.iam.gserviceaccount.com";
const PRIVATE_KEY = fakePrivateKey();
const VAULT = "AIzaSyVaultVaultVaultVaultVaultVault0001";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const fake: FakeGoogle = {
      serviceAccount: EMAIL,
      privateKey: PRIVATE_KEY,
      projects: ["481537286014"],
      valuePrefix: `AIzaSy${sentinel}`,
      tokenPrefix: `ya29.${sentinel}-`,
      world: memoryWorld([
        {
          name: "projects/481537286014/locations/global/keys/maps-web",
          value: VAULT,
          displayName: "Maps web",
        },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new GoogleIssuer({
        admin: async () => new Secret(serviceAccountJson(EMAIL, PRIVATE_KEY, sentinel)),
        projectNumber: "481537286014",
        fetch: googleFetch(fake),
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

describe("the service account key issuer contract", () => {
  const APP = "app@acme-prod.iam.gserviceaccount.com";
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const fake: FakeIam = {
      serviceAccount: EMAIL,
      privateKey: PRIVATE_KEY,
      tokenPrefix: `ya29.${sentinel}-`,
      manages: [APP],
      keyPrefix: `-----${sentinel}-----`,
      world: memoryIamWorld([
        { email: APP, project: "acme-prod", keys: [{ id: serviceAccountKeyId(0xf00) }] },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new ServiceAccountKeyIssuer({
        admin: async () => new Secret(serviceAccountJson(EMAIL, PRIVATE_KEY, sentinel)),
        fetch: iamFetch(fake),
      }),
      current: new Secret(iamKeyFile(APP, "acme-prod", serviceAccountKeyId(0xf00), "vault-pem")),
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});
