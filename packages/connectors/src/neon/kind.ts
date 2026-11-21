import type { IssuerKind } from "@keypin/core";
import { NeonIssuer } from "./neon";
import { neonIssuerRules, type NeonSpec } from "./rules";

export const neonIssuer: IssuerKind<NeonSpec> = {
  ...neonIssuerRules,
  connect: ({ projectId, branchId, database, roles }, admin, fetch) =>
    new NeonIssuer({
      admin: async () => admin,
      projectId,
      branchId,
      database,
      roles,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
