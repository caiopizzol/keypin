import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface TwilioSpec extends IssuerSpec {
  readonly kind: "twilio";
  readonly keyId: string;
}

export const twilioIssuerRules = {
  kind: "twilio",
  parse(read) {
    read.only(["key_id"]);
    const admin = read.admin();
    const keyId = read.idKey();
    return admin && keyId ? { kind: "twilio", admin, keyId } : undefined;
  },
  idKey: (spec) => spec.keyId,
} satisfies IssuerRules<TwilioSpec>;
