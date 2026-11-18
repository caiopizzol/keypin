import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { TwilioIssuer } from "../../src/twilio/index";
import { adminJson, type FakeTwilio, memoryWorld, twilioFetch } from "../../src/twilio/testing";

const ACCOUNT = `AC${"a".repeat(32)}`;
const APP_SID = `SK${"1".repeat(32)}`;
const APP_SECRET = "app-secret-0001";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const token = `token-${sentinel}`;
    const fake: FakeTwilio = {
      account: ACCOUNT,
      authToken: token,
      sidPrefix: "SKe",
      valuePrefix: `new-${sentinel}-`,
      world: memoryWorld([{ sid: APP_SID, secret: APP_SECRET, name: "app", type: "standard" }]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new TwilioIssuer({
        admin: async () =>
          new Secret(adminJson({ TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: token })),
        fetch: twilioFetch(fake),
      }),
      current: new Secret(APP_SECRET),
      currentId: APP_SID,
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});
