import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { GoogleIssuer } from "./google";

export interface GoogleSpec extends IssuerSpec {
  readonly kind: "google";
  readonly projectId: string;
}

export const googleIssuer: IssuerKind<GoogleSpec> = {
  kind: "google",
  parse(read) {
    read.only(["project_id"]);
    const admin = read.admin();
    const projectId = read.filledIn(
      read.required("project_id"),
      "project_id",
      "the Google Cloud project ID",
    );
    if (!admin || !projectId) return undefined;
    return { kind: "google", admin, projectId };
  },
  connect: ({ projectId }, admin, fetch) =>
    new GoogleIssuer({
      admin: async () => admin,
      projectId,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
