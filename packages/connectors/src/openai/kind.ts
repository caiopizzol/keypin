import type { IssuerKind, IssuerSpec } from "@keypin/core";
import { OpenAIIssuer } from "./openai";

export interface OpenAISpec extends IssuerSpec {
  readonly kind: "openai";
  readonly projectId: string;
  readonly scopes: readonly string[];
}

export const openaiIssuer: IssuerKind<OpenAISpec> = {
  kind: "openai",
  parse(read) {
    read.only(["project_id", "scopes"]);
    const admin = read.admin();
    const projectId = read.filledIn(
      read.required("project_id"),
      "project_id",
      "the OpenAI project ID",
    );
    const scopes = read.list("scopes");
    if (!admin || !projectId || !scopes) return undefined;
    return { kind: "openai", admin, projectId, scopes };
  },
  connect: ({ projectId, scopes }, admin, fetch) =>
    new OpenAIIssuer({
      admin: async () => admin,
      projectId,
      scopes,
      ...(fetch === undefined ? {} : { fetch }),
    }),
};
