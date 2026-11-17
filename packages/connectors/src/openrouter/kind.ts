import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { OpenRouterIssuer } from "./openrouter";

export interface OpenRouterSpec extends IssuerSpec {
  readonly kind: "openrouter";
}

export const openrouterIssuer: IssuerKind<OpenRouterSpec> = {
  kind: "openrouter",
  parse(read) {
    read.only([]);
    const admin = read.admin();
    if (!admin) return undefined;
    return { kind: "openrouter", admin };
  },
  connect: (_spec, admin, fetch) =>
    new OpenRouterIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
