import type { IssuerKind } from "@keypin/core";
import { SupabaseIssuer } from "./supabase";
import { supabaseIssuerRules, type SupabaseSpec } from "./rules";

export const supabaseIssuer: IssuerKind<SupabaseSpec> = {
  ...supabaseIssuerRules,
  connect: ({ projectRef }, admin, fetch) =>
    new SupabaseIssuer({
      admin: async () => admin,
      projectRef,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
