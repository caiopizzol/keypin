import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { AtlasIssuer } from "./atlas";

export interface AtlasSpec extends IssuerSpec {
  readonly kind: "mongodb-atlas";
  readonly clientId: string;
  readonly projectId: string;
}

export const atlasIssuer: IssuerKind<AtlasSpec> = {
  kind: "mongodb-atlas",
  parse(read) {
    read.only(["client_id", "project_id"]);
    const admin = read.admin();
    const clientId = read.filledIn(
      read.required("client_id"),
      "client_id",
      "the service account's client ID",
    );
    const projectId = read.filledIn(
      read.required("project_id"),
      "project_id",
      "the Atlas project ID",
    );
    if (projectId !== undefined && !/^[0-9a-f]{24}$/.test(projectId))
      read.fail(
        `field "project_id" must be the 24-character project ID from the project's settings`,
      );
    if (!admin || !clientId || !projectId || !/^[0-9a-f]{24}$/.test(projectId)) return undefined;
    return { kind: "mongodb-atlas", admin, clientId, projectId };
  },
  connect: ({ clientId, projectId }, admin, fetch) =>
    new AtlasIssuer({
      admin: async () => admin,
      clientId,
      projectId,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
