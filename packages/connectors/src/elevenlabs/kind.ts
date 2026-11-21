import type { IssuerKind } from "@keypin/core";
import { ElevenLabsIssuer } from "./elevenlabs";
import { elevenlabsIssuerRules, type ElevenLabsSpec } from "./rules";

export const elevenlabsIssuer: IssuerKind<ElevenLabsSpec> = {
  ...elevenlabsIssuerRules,
  connect: (_spec, admin, fetch) =>
    new ElevenLabsIssuer({
      admin: async () => admin,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
