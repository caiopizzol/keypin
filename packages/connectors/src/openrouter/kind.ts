import type { IssuerKind } from "@keypin/core";
import { OpenRouterIssuer } from "./openrouter";
import { openrouterIssuerRules, type OpenRouterSpec } from "./rules";

export const openrouterIssuer: IssuerKind<OpenRouterSpec> = {
  ...openrouterIssuerRules,
  connect: (_spec, admin, fetch) =>
    new OpenRouterIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
