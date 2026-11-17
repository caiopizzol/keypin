import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { RailwayVariablesDestination } from "../../src/railway/index";
import { type FakeRailway, railwayFetch } from "../../src/railway/testing";

const PROJECT = "1d01c0c0-4554-4747-93b8-34ce3448ab95";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeRailway = {
      email: "alice@example.com",
      projects: {
        [PROJECT]: {
          environments: [{ id: "env-prod", name: "production" }],
          services: [{ id: "svc-api", name: "api" }],
        },
      },
    };
    const railway = railwayFetch(fake);
    return {
      destination: new RailwayVariablesDestination({
        project: PROJECT,
        environment: "production",
        service: "api",
        token: async () => "fake-railway-token",
        fetch: railway.fetch,
      }),
      name: "API_KEY",
      effects: railway.effects,
      received: (name) => railway.value("env-prod", "svc-api", name),
      refuse: () => {
        fake.projects = {};
      },
      breakWrites: () => {
        fake.failWrites = true;
      },
    };
  });
});
