import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { ConvexEnvDestination } from "../../src/convex/index";
import { convexFetch, type FakeConvex } from "../../src/convex/testing";

const KEY = "prod:happy-animal-123|fake-convex-key";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeConvex = {
      deployments: { "happy-animal-123": { host: "happy-animal-123.convex.cloud" } },
      keys: { [KEY]: { deployment: "happy-animal-123", envWrite: true } },
    };
    const convex = convexFetch(fake);
    return {
      destination: new ConvexEnvDestination({
        url: "https://happy-animal-123.convex.cloud",
        key: async () => KEY,
        fetch: convex.fetch,
      }),
      name: "API_KEY",
      effects: convex.effects,
      received: (name) => convex.value("happy-animal-123", name),
      refuse: () => {
        fake.keys = {};
      },
      breakWrites: () => {
        fake.failWrites = true;
      },
    };
  });
});
