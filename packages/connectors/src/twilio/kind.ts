import type { IssuerKind } from "@keypin/core";
import { TwilioIssuer } from "./twilio";
import { twilioIssuerRules, type TwilioSpec } from "./rules";

export const twilioIssuer: IssuerKind<TwilioSpec> = {
  ...twilioIssuerRules,
  connect: (_spec, admin, fetch) =>
    new TwilioIssuer({ admin: async () => admin, ...(fetch === undefined ? {} : { fetch }) }),
};
