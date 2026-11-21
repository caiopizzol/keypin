import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface OpenRouterSpec extends IssuerSpec {
  readonly kind: "openrouter";
}

export const openrouterIssuerRules = {
  kind: "openrouter",
  parse(read) {
    read.only([]);
    const admin = read.admin();
    if (!admin) return undefined;
    return { kind: "openrouter", admin };
  },
} satisfies IssuerRules<OpenRouterSpec>;
