import type { DestinationRules, IssuerRules, IssuerSpec } from "@keypin/core";

export const REF = /^[a-z]{20}$/;
const RESERVED = "SUPABASE_";
const NAME_LIMIT = 256;

export function refusedName(name: string): string | undefined {
  if (name.startsWith(RESERVED))
    return `Supabase reserves names that start with ${RESERVED} for the variables it sets itself`;
  if (name.length > NAME_LIMIT)
    return `Supabase takes secret names of up to ${NAME_LIMIT} characters`;
  return undefined;
}

export interface SupabaseSpec extends IssuerSpec {
  readonly kind: "supabase";
  readonly projectRef: string;
}

export const supabaseIssuerRules = {
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
} satisfies IssuerRules<SupabaseSpec>;

export type SupabaseFunctionsTarget = {
  to: "supabase-functions";
  account: string;
};

export const supabaseFunctionsRules: DestinationRules<SupabaseFunctionsTarget> = {
  kind: "supabase-functions",
  label: "Supabase",
  parse(read) {
    read.only(["project_ref"]);
    const ref = read.filledIn(
      read.required("project_ref"),
      "project_ref",
      "the Supabase project ref, from its dashboard URL",
    );
    if (ref !== undefined && !REF.test(ref)) {
      read.fail(`field "project_ref" must be the project's 20-letter ref, from its dashboard URL`);
      return undefined;
    }
    return ref === undefined ? undefined : { to: "supabase-functions", account: ref };
  },
  id: ({ account }) => account,
  secretId: ({ account }, secretName) => `${account}:${secretName}`,
  checkId: ({ account }) => account,
  fromId: (id) => (REF.test(id) ? { to: "supabase-functions", account: id } : undefined),
  describe: ({ account }) => account,
  named: ({ account }) => `the Edge Function secrets of Supabase project ${account}`,
  refuses: refusedName,
};
