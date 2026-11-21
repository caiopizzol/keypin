import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface ElevenLabsSpec extends IssuerSpec {
  readonly kind: "elevenlabs";
}

export const elevenlabsIssuerRules = {
  kind: "elevenlabs",
  parse(read) {
    read.only([]);
    const admin = read.admin();
    if (!admin) return undefined;
    return { kind: "elevenlabs", admin };
  },
} satisfies IssuerRules<ElevenLabsSpec>;
