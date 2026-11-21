import type { IssuerRules, IssuerSpec } from "@keypin/core";

export interface OpenAISpec extends IssuerSpec {
  readonly kind: "openai";
  readonly projectId: string;
  readonly scopes: readonly string[];
}

export const openaiIssuerRules = {
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
} satisfies IssuerRules<OpenAISpec>;
