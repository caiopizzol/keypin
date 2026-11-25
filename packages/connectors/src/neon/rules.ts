import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface NeonSpec extends IssuerSpec {
  readonly kind: "neon";
  readonly projectId: string;
  readonly branchId: string;
  readonly database: string;
  readonly roles: readonly [string, string];
}

export const neonIssuerRules = {
  kind: "neon",
  names: false,
  parse(read) {
    read.only(["project_id", "branch_id", "database", "roles"]);
    const admin = read.admin();
    const projectId = read.filledIn(
      read.required("project_id"),
      "project_id",
      "the Neon project ID",
    );
    const branchId = read.filledIn(read.required("branch_id"), "branch_id", "the Neon branch ID");
    const database = read.filledIn(read.required("database"), "database", "the database name");
    const listed = read.list("roles");
    const [first, second, ...more] = listed ?? [];
    const roles: NeonSpec["roles"] | null =
      first && second && !more.length && first !== second ? [first, second] : null;
    if (listed !== undefined && !roles)
      read.fail(`field "roles" must name two different roles, such as ["app_a", "app_b"]`);
    if (!admin || !projectId || !branchId || !database || !roles) return undefined;
    return { kind: "neon", admin, projectId, branchId, database, roles };
  },
  claims: ({ projectId, branchId, roles }) =>
    roles.map((role) => `role ${role} on Neon branch ${branchId} of project ${projectId}`),
} satisfies IssuerRules<NeonSpec>;
