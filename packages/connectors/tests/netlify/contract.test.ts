import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { NetlifyEnvDestination } from "../../src/netlify/index";
import { type FakeNetlify, netlifyFetch } from "../../src/netlify/testing";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeNetlify = {
      email: "alice@example.com",
      teams: { acme: { id: "acct_1", projects: { "web.netlify.app": "site-1" } } },
    };
    const netlify = netlifyFetch(fake);
    return {
      destination: new NetlifyEnvDestination({
        team: "acme",
        project: "web.netlify.app",
        context: "production",
        token: async () => "fake-netlify-token",
        fetch: netlify.fetch,
      }),
      name: "API_KEY",
      effects: netlify.effects,
      received: (name) => netlify.value(name, "production"),
      refuse: () => {
        fake.teams = {};
      },
      breakWrites: () => {
        fake.failWrites = true;
      },
    };
  });
});
