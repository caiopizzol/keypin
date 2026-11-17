import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { GoogleIssuer } from "../../src/google/index";
import {
  type FakeGoogle,
  fakePrivateKey,
  googleFetch,
  memoryWorld,
  serviceAccountJson,
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
      projects: ["acme-prod"],
      valuePrefix: `AIzaSy${sentinel}`,
      tokenPrefix: `ya29.${sentinel}-`,
      world: memoryWorld([
        {
          name: "projects/acme-prod/locations/global/keys/maps-web",
          value: VAULT,
          displayName: "Maps web",
        },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new GoogleIssuer({
        admin: async () => new Secret(serviceAccountJson(EMAIL, PRIVATE_KEY, sentinel)),
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
