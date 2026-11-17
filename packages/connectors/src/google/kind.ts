import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { GoogleIssuer } from "./google";

export interface GoogleSpec extends IssuerSpec {
  readonly kind: "google";
  readonly projectNumber: string;
}

export const googleIssuer: IssuerKind<GoogleSpec> = {
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
  connect: ({ projectNumber }, admin, fetch) =>
    new GoogleIssuer({
      admin: async () => admin,
      projectNumber,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
