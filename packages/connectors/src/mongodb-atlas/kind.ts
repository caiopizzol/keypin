import type { IssuerKind } from "@keypin/core";
import { AtlasIssuer } from "./atlas";
import { atlasIssuerRules, type AtlasSpec } from "./rules";

export const atlasIssuer: IssuerKind<AtlasSpec> = {
  ...atlasIssuerRules,
  connect: ({ clientId, projectId }, admin, fetch) =>
    new AtlasIssuer({
      admin: async () => admin,
      clientId,
      projectId,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
