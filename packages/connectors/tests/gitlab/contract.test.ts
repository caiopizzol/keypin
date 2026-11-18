import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { GitLabVariablesDestination } from "../../src/gitlab/index";
import { type FakeGitLab, gitlabFetch } from "../../src/gitlab/testing";

const TOKEN = "glpat-fake-gitlab-token";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeGitLab = {
      tokens: { [TOKEN]: { user: "alice", scopes: ["api"], reaches: { "acme/billing": "admin" } } },
    };
    const gitlab = gitlabFetch(fake);
    return {
      destination: new GitLabVariablesDestination({
        owner: "project",
        host: "gitlab.com",
        path: "acme/billing",
        environmentScope: "*",
        via: "token",
        token: async () => TOKEN,
        fetch: gitlab.fetch,
      }),
      name: "API_KEY",
      effects: gitlab.effects,
      received: (name) => gitlab.value("acme/billing", name),
      refuse: () => {
        fake.tokens = {};
      },
      breakWrites: () => {
        fake.failWrites = true;
      },
    };
  });
});
