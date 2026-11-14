import { describe } from "vite-plus/test";
import { destinationContract } from "@keypin/core/testing";
import { WorkerSecretDestination } from "../src/index";
import { cloudflareFetch, type FakeCloudflare } from "../src/testing";

const ACCOUNT = "11111111111111111111111111111111";

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeCloudflare = { email: "me@example.com", accounts: { [ACCOUNT]: ["billing"] } };
    const cloudflare = cloudflareFetch(fake);
    return {
      destination: new WorkerSecretDestination({
        account: ACCOUNT,
        worker: "billing",
        token: async () => "fake-wrangler-token",
        fetch: cloudflare.fetch,
      }),
      name: "API_KEY",
      effects: cloudflare.effects,
      received: (name) => cloudflare.value(ACCOUNT, "billing", name),
      refuse: () => {
        fake.accounts = {};
      },
      breakWrites: () => {
        fake.failPut = true;
      },
    };
  });
});
