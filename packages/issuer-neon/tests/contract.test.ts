import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { NeonIssuer } from "../src/index";
import { type FakeNeon, memoryWorld, neonFetch } from "../src/testing";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const admin = `napi_${sentinel}`;
    const fake: FakeNeon = {
      admin,
      projectId: "proj-1",
      branchId: "br-main",
      database: "appdb",
      host: "ep-quiet-1.us-east-2.aws.neon.tech",
      passwordPrefix: `npg_${sentinel}_`,
      world: memoryWorld({ app_a: "npg_live_a_9f2c", app_b: "npg_idle_b_4d1e" }),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new NeonIssuer({
        admin: async () => new Secret(admin),
        projectId: "proj-1",
        branchId: "br-main",
        database: "appdb",
        roles: ["app_a", "app_b"],
        fetch: neonFetch(fake),
        sleep: async () => undefined,
      }),
      current: new Secret(
        "postgresql://app_a:npg_live_a_9f2c@ep-quiet-1.us-east-2.aws.neon.tech/appdb?sslmode=require",
      ),
      effects,
      failCreate: () => {
        fake.failReset = "refuse";
      },
    };
  });
});
