import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { ElevenLabsIssuer } from "./elevenlabs";

export interface ElevenLabsSpec extends IssuerSpec {
  readonly kind: "elevenlabs";
}

export const elevenlabsIssuer: IssuerKind<ElevenLabsSpec> = {
  kind: "elevenlabs",
  parse(read) {
    read.only([]);
    const admin = read.admin();
    if (!admin) return undefined;
    return { kind: "elevenlabs", admin };
  },
  connect: (_spec, admin, fetch) =>
    new ElevenLabsIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
