import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { VercelEnvDestination } from "../../src/vercel/index";
import { type FakeVercel, vercelFetch } from "../../src/vercel/testing";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeVercel = {
      username: "alice",
      teams: { team_acme: { slug: "acme", projects: { web: [] } } },
    };
    const vercel = vercelFetch(fake);
    return {
      destination: new VercelEnvDestination({
        team: "team_acme",
        project: "web",
        environment: "production",
        token: async () => "fake-vercel-token",
        fetch: vercel.fetch,
      }),
      name: "API_KEY",
      effects: vercel.effects,
      received: (name) => vercel.value(name, "production"),
      refuse: () => {
        fake.teams = {};
      },
      breakWrites: () => {
        fake.failWrites = true;
      },
    };
  });
});
