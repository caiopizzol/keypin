import type { StoreRead } from "@keypin/core";
import type { WorkflowRefs } from "./workflows";

export interface WorkflowHost {
  git(folder: string, args: readonly string[]): Promise<string | null>;
  githubSecrets(repo: string, login: string | null, environment?: string): Promise<StoreRead>;
  organizationSecrets(repo: string, login: string | null): Promise<StoreRead>;
  sshHostname(destination: string): Promise<string | null>;
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
}
