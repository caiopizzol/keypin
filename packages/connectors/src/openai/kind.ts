import type { IssuerKind } from "@keypin/core";
import { OpenAIIssuer } from "./openai";
import { openaiIssuerRules, type OpenAISpec } from "./rules";

export const openaiIssuer: IssuerKind<OpenAISpec> = {
  ...openaiIssuerRules,
  connect: ({ projectId, scopes }, admin, fetch) =>
    new OpenAIIssuer({
      admin: async () => admin,
      projectId,
      scopes,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
