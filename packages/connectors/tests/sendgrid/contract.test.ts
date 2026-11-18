import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { SendGridIssuer } from "../../src/sendgrid/index";
import { type FakeSendGrid, memoryWorld, sendgridFetch } from "../../src/sendgrid/testing";

const OLD = "SG.OldKeyId.in_the_vault_secret";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `SG.AdminId.${sentinel}`;
    const fake: FakeSendGrid = {
      admin,
      valuePrefix: `${sentinel}_`,
      world: memoryWorld([
        { id: "OldKeyId", name: "app", value: OLD, scopes: ["mail.send", "2fa_required"] },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new SendGridIssuer({
        admin: async () => new Secret(admin),
        fetch: sendgridFetch(fake),
      }),
      current: new Secret(OLD),
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});
