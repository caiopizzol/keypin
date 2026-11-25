import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface GoogleSpec extends IssuerSpec {
  readonly kind: "google";
  readonly projectNumber: string;
}

export const googleIssuerRules = {
  kind: "google",
  parse(read) {
    read.only(["project_number"]);
    const admin = read.admin();
    const projectNumber = read.filledIn(
      read.required("project_number"),
      "project_number",
      "the Google Cloud project number",
    );
    if (projectNumber !== undefined && !/^\d+$/.test(projectNumber))
      read.fail(
        `field "project_number" must be the project's number, digits only, not its ID: find it on the project's Dashboard in the Google Cloud console`,
      );
    if (!admin || !projectNumber || !/^\d+$/.test(projectNumber)) return undefined;
    return { kind: "google", admin, projectNumber };
  },
} satisfies IssuerRules<GoogleSpec>;

export interface GoogleServiceAccountSpec extends IssuerSpec {
  readonly kind: "google-service-account";
}

export const googleServiceAccountIssuerRules = {
  kind: "google-service-account",
  names: false,
  parse(read) {
    read.only([]);
    const admin = read.admin();
    return admin ? { kind: "google-service-account", admin } : undefined;
  },
} satisfies IssuerRules<GoogleServiceAccountSpec>;
