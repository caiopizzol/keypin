import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { AwsIssuer } from "../../src/aws/index";
import { accessKeyJson, awsFetch, type FakeAws, memoryWorld } from "../../src/aws/testing";

const APP_ID = "AKIAAPPAPPAPPAPP0001";
const APP_SECRET = "app/secret/value/0001";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = { id: "AKIAADMINADMINADMIN1", secret: `admin-${sentinel}` };
    const fake: FakeAws = {
      account: "123456789012",
      idPrefix: "AKIANEW",
      valuePrefix: `new-${sentinel}-`,
      world: memoryWorld([
        { ...admin, user: "keypin-admin" },
        { id: APP_ID, secret: APP_SECRET, user: "app" },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new AwsIssuer({
        admin: async () => new Secret(accessKeyJson(admin.id, admin.secret)),
        fetch: awsFetch(fake),
        sleep: async () => {},
      }),
      current: new Secret(APP_SECRET),
      currentId: APP_ID,
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});
