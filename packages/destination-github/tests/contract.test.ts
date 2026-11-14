import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { GitHubSecretDestination } from "../src/index";
import { type FakeGitHub, githubFetch } from "../src/testing";

for (const environment of [undefined, "prod/eu"]) {
  describe(`the destination contract, ${environment ?? "repo"} secret`, () => {
    destinationContract(async () => {
      const fake: FakeGitHub = {
        login: "acme",
        repos: {
          "acme/billing": {
            owner: "acme",
            push: true,
            ...(environment ? { environments: [environment] } : {}),
          },
        },
      };
      const github = await githubFetch(fake);
      return {
        destination: new GitHubSecretDestination({
          repo: "acme/billing",
          token: async () => "fake-gh-token",
          fetch: github.fetch,
          ...(environment ? { environment } : {}),
        }),
        name: "API_KEY",
        effects: github.effects,
        received: (name) => github.value("acme/billing", name, environment),
        refuse: () => {
          fake.repos["acme/billing"] = { owner: "someone-else", push: true };
        },
        breakWrites: () => {
          fake.failPut = true;
        },
      };
    });
  });
}
