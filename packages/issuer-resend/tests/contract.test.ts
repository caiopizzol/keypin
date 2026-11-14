import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { ResendIssuer } from "../src/index";
import { type FakeResend, memoryKeys, resendFetch } from "../src/testing";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `re_admin_${sentinel}`;
    const fake: FakeResend = {
      admin,
      tokenPrefix: `re_${sentinel}_`,
      keys: memoryKeys(["re-old"]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new ResendIssuer({
        admin: async () => new Secret(admin),
        permission: "sending_access",
        fetch: resendFetch(fake),
      }),
      effects,
      failCreate: () => {
        fake.failCreate = true;
      },
    };
  });
});
