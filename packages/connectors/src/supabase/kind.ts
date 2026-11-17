import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { SupabaseIssuer } from "./supabase";

export interface SupabaseSpec extends IssuerSpec {
  readonly kind: "supabase";
  readonly projectRef: string;
}

export const supabaseIssuer: IssuerKind<SupabaseSpec> = {
  kind: "supabase",
  parse(read) {
    read.only(["project_ref"]);
    const admin = read.admin();
    const given = read.filledIn(
      read.required("project_ref"),
      "project_ref",
      "the Supabase project ref",
    );
    const projectRef = given !== undefined && /^[a-z]{20}$/.test(given) ? given : undefined;
    if (given !== undefined && !projectRef)
      read.fail(`field "project_ref" must be the project's 20-letter ref, from its dashboard URL`);
    if (!admin || !projectRef) return undefined;
    return { kind: "supabase", admin, projectRef };
  },
  connect: ({ projectRef }, admin, fetch) =>
    new SupabaseIssuer({
      admin: async () => admin,
      projectRef,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
