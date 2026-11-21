import type { Pulled, StoreRead } from "@keypin/core";
import type { WorkflowRefs } from "./workflows";

export interface WorkflowHost {
  git(folder: string, args: readonly string[]): Promise<string | null>;
  githubSecrets(repo: string, login: string | null, environment?: string): Promise<StoreRead>;
  organizationSecrets(repo: string, login: string | null): Promise<StoreRead>;
  sshHostname(destination: string): Promise<string | null>;
  readonly vaults: readonly { readonly oidcVariables?: readonly string[] }[];
}

export interface Workflow {
  path: string;
  refs: WorkflowRefs;
}

export interface Repo {
  repo: string | null;
  read: StoreRead | null;
  organization: StoreRead | null;
  environments: { name: string; read: StoreRead }[];
  pulled: { pulled: Pulled; repo: string; environment: string | null; read: StoreRead }[];
}

export type PulledAt = Repo["pulled"][number];
