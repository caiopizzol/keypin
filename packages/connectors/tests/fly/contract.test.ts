import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { FlySecretsDestination } from "../../src/fly/index";
import { type FakeFly, flyFetch } from "../../src/fly/testing";

const TOKEN = "FlyV1 fm2_fake-fly-token";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeFly = {
      apps: { "billing-api": { org: "acme" } },
      tokens: { [TOKEN]: { org: "acme", apps: ["billing-api"] } },
    };
    const fly = flyFetch(fake);
    return {
      destination: new FlySecretsDestination({
        app: "billing-api",
        token: async () => TOKEN,
        fetch: fly.fetch,
      }),
      name: "API_KEY",
      effects: fly.effects,
      received: (name) => fly.value("billing-api", name),
      refuse: () => {
        fake.tokens = {};
      },
      breakWrites: () => {
        fake.failWrites = true;
      },
    };
  });
});
