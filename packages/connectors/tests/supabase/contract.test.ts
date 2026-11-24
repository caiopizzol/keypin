import { describe, expect, test } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { destinationContract, issuerContract } from "@keypin/core/testing";
import { SupabaseIssuer, SupabaseSecretsDestination } from "../../src/supabase/index";
import {
  type FakeSecrets,
  type FakeSupabase,
  memoryWorld,
  secretsFetch,
  supabaseFetch,
} from "../../src/supabase/testing";

const REF = "abcdefghijklmnopqrst";
const VAULT = "sb_secret_vaultkey12345_9a7f";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `sbp_${sentinel}`;
    const fake: FakeSupabase = {
      admin,
      projectRef: REF,
      valuePrefix: `sb_secret_${sentinel}_`,
      world: memoryWorld([
        {
          id: "key-default",
          name: "default",
          type: "secret",
          value: "sb_secret_defaultkey99_1b2c",
        },
        { id: "key-backend", name: "backend", type: "secret", value: VAULT },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new SupabaseIssuer({
        admin: async () => new Secret(admin),
        projectRef: REF,
        fetch: supabaseFetch(fake),
      }),
      current: new Secret(VAULT),
      vaultId: "key-backend",
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});

describe("the destination contract", () => {
  destinationContract(() => {
    const fake: FakeSecrets = { token: "sbp_fake", username: "alice", projects: { [REF]: {} } };
    const supabase = secretsFetch(fake);
    return {
      destination: new SupabaseSecretsDestination({
        projectRef: REF,
        token: async () => "sbp_fake",
        fetch: supabase.fetch,
      }),
      name: "API_KEY",
      effects: supabase.effects,
      received: (name) => fake.projects[REF]?.[name],
      refuse: () => {
        fake.projects = {};
      },
      breakWrites: () => {
        fake.failWrites = 400;
      },
    };
  });
});

describe("the fake Supabase", () => {
  test("never hands out an ID or value twice, even after another key is revoked", async () => {
    const issuer = new SupabaseIssuer({
      admin: async () => new Secret("sbp_admin"),
      projectRef: REF,
      fetch: supabaseFetch({
        projectRef: REF,
        valuePrefix: "sb_secret_fake_",
        world: memoryWorld([{ id: "key-backend", name: "backend", type: "secret", value: VAULT }]),
        effect: () => undefined,
      }),
    });
    expect((await issuer.checkAccount(null, new Secret(VAULT))).ok).toBe(true);
    const first = await issuer.create("FIRST_KEY prod");
    expect(await issuer.revoke("key-backend", first.secret)).toBe("revoked");
    const second = await issuer.create("SECOND_KEY prod");
    expect(second.id).not.toBe(first.id);
    expect(second.secret.equals(first.secret)).toBe(false);
  });
});
