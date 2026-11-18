import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { TwilioIssuer } from "./twilio";

export interface TwilioSpec extends IssuerSpec {
  readonly kind: "twilio";
  readonly keyId: string;
}

export const twilioIssuer: IssuerKind<TwilioSpec> = {
  kind: "twilio",
  parse(read) {
    read.only(["key_id"]);
    const admin = read.admin();
    const keyId = read.idKey();
    return admin && keyId ? { kind: "twilio", admin, keyId } : undefined;
  },
  connect: (_spec, admin, fetch) =>
    new TwilioIssuer({ admin: async () => admin, ...(fetch === undefined ? {} : { fetch }) }),
  idKey: (spec) => spec.keyId,
};
