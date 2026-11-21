import type { IssuerKind } from "@keypin/core";
import { GoogleIssuer } from "./google";
import { ServiceAccountKeyIssuer } from "./service-account";
import {
  googleIssuerRules,
  googleServiceAccountIssuerRules,
  type GoogleServiceAccountSpec,
  type GoogleSpec,
} from "./rules";

export const googleIssuer: IssuerKind<GoogleSpec> = {
  ...googleIssuerRules,
  connect: ({ projectNumber }, admin, fetch) =>
    new GoogleIssuer({
      admin: async () => admin,
      projectNumber,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};

export const googleServiceAccountIssuer: IssuerKind<GoogleServiceAccountSpec> = {
  ...googleServiceAccountIssuerRules,
  connect: (_spec, admin, fetch) =>
    new ServiceAccountKeyIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
