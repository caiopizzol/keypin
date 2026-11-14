import { describe, expect, test } from "vite-plus/test";
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

describe("the fake Resend", () => {
  test("never hands out an ID or token twice, even after another key is revoked", async () => {
    const issuer = new ResendIssuer({
      admin: async () => new Secret("re_admin"),
      permission: "sending_access",
      fetch: resendFetch({
        tokenPrefix: "re_fake_",
        keys: memoryKeys(["re-old"]),
        effect: () => undefined,
      }),
    });
    expect((await issuer.checkAccount("re-old")).ok).toBe(true);
    const first = await issuer.create("first");
    expect(await issuer.revoke("re-old")).toBe("revoked");
    const second = await issuer.create("second");
    expect(second.id).not.toBe(first.id);
    expect(second.secret.equals(first.secret)).toBe(false);
  });
});
