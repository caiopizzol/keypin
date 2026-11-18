import { describe } from "vite-plus/test";
import { Secret } from "@keypin/core";
import { issuerContract } from "@keypin/core/testing";
import { AtlasIssuer } from "../../src/mongodb-atlas/index";
import { atlasFetch, type FakeAtlas, memoryWorld } from "../../src/mongodb-atlas/testing";

const PROJECT = "5f1a2b3c4d5e6f7a8b9c0d1e";

describe("the issuer contract", () => {
  issuerContract((sentinel) => {
    const effects: string[] = [];
    const secret = `mdb_sa_sk_${sentinel}`;
    const fake: FakeAtlas = {
      clientId: "mdb_sa_id_app",
      secret,
      projectId: PROJECT,
      clusters: [{ name: "Cluster0", srvHost: "cluster0.ab1cd.mongodb.net" }],
      world: memoryWorld([
        {
          username: "app",
          password: "in_the_vault_password",
          roles: [{ roleName: "readWrite", databaseName: "appdb" }],
        },
      ]),
      effect: (line) => void effects.push(line),
    };
    return {
      issuer: new AtlasIssuer({
        admin: async () => new Secret(secret),
        clientId: "mdb_sa_id_app",
        projectId: PROJECT,
        fetch: atlasFetch(fake),
        password: () => `${sentinel}_password`,
        sleep: async () => undefined,
      }),
      current: new Secret(
        "mongodb+srv://app:in_the_vault_password@cluster0.ab1cd.mongodb.net/appdb?retryWrites=true&w=majority",
      ),
      effects,
      failCreate: () => {
        fake.failCreate = 500;
      },
    };
  });
});
